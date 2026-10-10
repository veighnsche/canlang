import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commitOutboxIntent, stageOutboxIntent } from '../intent/index.js';
import {
  attemptDispatchAsync, assertDispatchGuardExecution, readDispatchGuardExecution, registerDispatchGuardRevalidation,
} from './index.js';
import type {
  AsyncDispatchAttempt, AsyncDispatchDeps, AsyncGuardEvaluator, DispatchGuardExecution,
} from './index.js';

function setup(evaluateGuard: AsyncGuardEvaluator) {
  const order: string[] = [];
  const intent = commitOutboxIntent(stageOutboxIntent({
    operationId: '0193f2c0-0000-7000-8000-000000000002', source: 'Mail.send',
    occurrenceIndex: 0, request: { to: 'a@test' }, originOccurrence: null,
  }), { revision: 3, committedAtMs: 50 });
  const deps: AsyncDispatchDeps = {
    supersessions: { markSuperseded: () => {}, isSuperseded: () => { order.push('supersession'); return false; } },
    availability: { isTargetAvailable: () => { order.push('availability'); return true; } },
    evaluateGuard: (...args) => { order.push('guard'); return evaluateGuard(...args); },
    claimIds: { nextClaimId: () => { order.push('claim'); return 'claim-1'; } },
    clock: { nowMs: () => 100 },
  };
  const attempt: AsyncDispatchAttempt = {
    intent, guard: { predicate: 'members.current' },
    frozenInputs: { ids: ['a'] }, stateSnapshot: { held: 1 },
    fence: { checkpoint: { revision: 4, owner: 'team-a' },
      triggerRevision: { revision: 3 },
      revalidateAuthority: async () => { order.push('authority'); return true; } },
  };
  return { deps, attempt, order };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('async actual dispatch guard execution', () => {
  it('preserves lazy refusal ordering without opening an execution or claiming', async () => {
    for (const expected of ['refused-uncommitted', 'refused-inherited-scope', 'superseded', 'refused-state', 'unavailable']) {
      const { deps, attempt, order } = setup(() => { throw new Error('guard must stay lazy'); });
      if (expected === 'refused-uncommitted') attempt.intent = { item: attempt.intent.item, commit: null };
      if (expected === 'refused-inherited-scope') attempt.fence = { checkpoint: { revision: 3, owner: 'team-a' }, triggerRevision: { revision: 3 } };
      if (expected === 'superseded') deps.supersessions = { markSuperseded: () => {}, isSuperseded: () => { order.push('supersession'); return true; } };
      if (expected === 'refused-state') attempt.intent.item.state = 'claimed';
      if (expected === 'unavailable') deps.availability = { isTargetAvailable: () => { order.push('availability'); return false; } };
      assert.equal((await attemptDispatchAsync(deps, attempt)).status, expected);
      assert.deepEqual(order, expected === 'unavailable' ? ['supersession', 'availability']
        : expected === 'superseded' || expected === 'refused-state' ? ['supersession'] : []);
    }
  });

  it('awaits false and refuses nonboolean truth without authority or claim', async () => {
    for (const verdict of [false, 'true']) {
      const { deps, attempt, order } = setup(async () => verdict as boolean);
      assert.equal((await attemptDispatchAsync(deps, attempt)).status, 'skipped');
      assert.deepEqual(order, ['supersession', 'availability', 'guard']);
    }
  });

  it('propagates rejected guard readers and closes execution', async () => {
    let retained!: DispatchGuardExecution;
    const failure = new Error('membership reader rejected');
    const { deps, attempt, order } = setup(async (_predicate, _inputs, _state, execution) => {
      retained = execution;
      await Promise.resolve();
      throw failure;
    });
    await assert.rejects(attemptDispatchAsync(deps, attempt), error => error === failure);
    assert.throws(() => readDispatchGuardExecution(retained), /not live/);
    assert.deepEqual(order, ['supersession', 'availability', 'guard']);
  });

  it('checks current authority after awaited guard and never claims on revocation', async () => {
    const gate = deferred();
    let authorized = true;
    const { deps, attempt, order } = setup(async () => { await gate.promise; return true; });
    attempt.fence = { checkpoint: { revision: 4, owner: 'team-a' }, revalidateAuthority: async () => {
      order.push('authority'); return authorized;
    } };
    const pending = attemptDispatchAsync(deps, attempt);
    authorized = false;
    gate.resolve();
    assert.equal((await pending).status, 'refused-revoked');
    assert.deepEqual(order, ['supersession', 'availability', 'guard', 'authority']);
  });

  it('owns frozen bounded context live across await, rejects copies and closes before authority', async () => {
    const gate = deferred();
    let retained!: DispatchGuardExecution;
    let context!: ReturnType<typeof readDispatchGuardExecution>;
    const { deps, attempt, order } = setup(async (predicate, inputs, state, execution) => {
      retained = execution;
      context = readDispatchGuardExecution(execution);
      assert.equal(context.predicate, predicate);
      assert.equal(context.frozenInputs, inputs);
      assert.equal(context.stateSnapshot, state);
      assert.ok(Object.isFrozen(execution));
      assert.ok(Object.isFrozen((inputs as { ids: string[] }).ids));
      assert.ok(Object.isFrozen(context.intent.item.request));
      assert.throws(() => assertDispatchGuardExecution({ ...execution }), /not live/);
      assert.throws(() => assertDispatchGuardExecution({}), /not live/);
      await gate.promise;
      assertDispatchGuardExecution(execution);
      return true;
    });
    attempt.fence = { checkpoint: { revision: 4, owner: 'team-a' }, revalidateAuthority: async () => {
      assert.throws(() => readDispatchGuardExecution(retained), /not live/);
      order.push('authority'); return true;
    } };
    const pending = attemptDispatchAsync(deps, attempt);
    (attempt.frozenInputs as { ids: string[] }).ids.push('b');
    (attempt.stateSnapshot as { held: number }).held = 99;
    assert.deepEqual(context.frozenInputs, { ids: ['a'] });
    assert.deepEqual(context.stateSnapshot, { held: 1 });
    assert.equal(context.intent.item.id, attempt.intent.item.id);
    assert.deepEqual(context.checkpoint, { revision: 4, owner: 'team-a' });
    gate.resolve();
    assert.equal((await pending).status, 'claimed');
    assert.throws(() => readDispatchGuardExecution(retained), /not live/);
    assert.deepEqual(order, ['supersession', 'availability', 'guard', 'authority', 'claim']);
  });

  it('closes synchronous guards immediately and propagates authority rejection', async () => {
    let retained!: DispatchGuardExecution;
    const { deps, attempt, order } = setup((_p, _i, _s, execution) => {
      retained = execution; return true;
    });
    const failure = new Error('authority reader rejected');
    attempt.fence = { checkpoint: { revision: 4, owner: 'team-a' }, revalidateAuthority: async () => {
      order.push('authority'); throw failure;
    } };
    const pending = attemptDispatchAsync(deps, attempt);
    assert.throws(() => readDispatchGuardExecution(retained), /not live/);
    await assert.rejects(pending, error => error === failure);
    assert.equal(order.includes('claim'), false);
  });

  it('keeps absent guards unconditional and rejects unsupported or excessive snapshot data before callback', async () => {
    const unconditional = setup(() => { throw new Error('absent guard must stay lazy'); });
    unconditional.attempt.guard = { predicate: null };
    assert.equal((await attemptDispatchAsync(unconditional.deps, unconditional.attempt)).status, 'claimed');
    assert.deepEqual(unconditional.order, ['supersession', 'availability', 'authority', 'claim']);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const inputs of [cycle, new Map(), new Array(10_001), { get value() { throw new Error('must not invoke accessor'); } }]) {
      const { deps, attempt, order } = setup(() => { throw new Error('snapshot must refuse before callback'); });
      attempt.frozenInputs = inputs;
      await assert.rejects(attemptDispatchAsync(deps, attempt), /snapshot/);
      assert.deepEqual(order, ['supersession', 'availability']);
    }
  });

  it('revalidates observed evidence before true or false guard outcomes and closes enrollment first', async () => {
    for (const guardVerdict of [true, false]) {
      const gate = deferred();
      let current = true;
      const { deps, attempt, order } = setup(async (_p, _i, _s, execution) => {
        const observed = current;
        registerDispatchGuardRevalidation(execution, async () => {
          assert.throws(() => registerDispatchGuardRevalidation(execution, () => true), /not live/);
          assert.throws(() => readDispatchGuardExecution(execution), /not live/);
          order.push('observation');
          return current === observed;
        });
        await gate.promise;
        return guardVerdict;
      });
      const pending = attemptDispatchAsync(deps, attempt);
      current = false;
      gate.resolve();
      assert.equal((await pending).status, 'refused-revoked');
      assert.deepEqual(order, ['supersession', 'availability', 'guard', 'observation']);
    }
  });

  it('preserves unchanged negative evidence and checks observations sequentially before a skip', async () => {
    const observed = false;
    const { deps, attempt, order } = setup((_p, _i, _s, execution) => {
      registerDispatchGuardRevalidation(execution, async () => {
        await Promise.resolve(); order.push('negative-observation'); return false === observed;
      });
      registerDispatchGuardRevalidation(execution, () => {
        order.push('second-observation'); return true;
      });
      return false;
    });
    assert.equal((await attemptDispatchAsync(deps, attempt)).status, 'skipped');
    assert.deepEqual(order, ['supersession', 'availability', 'guard', 'negative-observation', 'second-observation']);
  });

  it('rejects caught fabricated, copied and closed enrollment without affecting another execution', async () => {
    let closed!: DispatchGuardExecution;
    const first = setup((_p, _i, _s, execution) => { closed = execution; return false; });
    await attemptDispatchAsync(first.deps, first.attempt);
    const { deps, attempt, order } = setup((_p, _i, _s, execution) => {
      for (const foreign of [{}, { ...execution }, closed]) {
        assert.throws(() => registerDispatchGuardRevalidation(foreign as DispatchGuardExecution, () => true), /not live/);
      }
      registerDispatchGuardRevalidation(execution, () => { order.push('observation'); return true; });
      return true;
    });
    assert.equal((await attemptDispatchAsync(deps, attempt)).status, 'claimed');
    assert.deepEqual(order, ['supersession', 'availability', 'guard', 'observation', 'authority', 'claim']);
  });

  it('propagates observation errors and refuses nonboolean revalidation loudly', async () => {
    const failure = new Error('current membership reader failed');
    for (const revalidate of [async () => { throw failure; }, () => 'true' as unknown as boolean]) {
      const { deps, attempt, order } = setup((_p, _i, _s, execution) => {
        registerDispatchGuardRevalidation(execution, revalidate); return false;
      });
      await assert.rejects(attemptDispatchAsync(deps, attempt), error =>
        error === failure || error instanceof TypeError && /return a boolean/.test(error.message));
      assert.deepEqual(order, ['supersession', 'availability', 'guard']);
    }
  });

  it('bounds live enrollment to 200 functions', async () => {
    const { deps, attempt } = setup((_p, _i, _s, execution) => {
      assert.throws(() => registerDispatchGuardRevalidation(execution, null as unknown as () => boolean), /must be a function/);
      for (let index = 0; index < 200; index++) registerDispatchGuardRevalidation(execution, () => true);
      assert.throws(() => registerDispatchGuardRevalidation(execution, () => true), /exceed bounds/);
      return true;
    });
    assert.equal((await attemptDispatchAsync(deps, attempt)).status, 'claimed');
  });

  it('owns decoded bigint values and refuses undefined, nonfinite, sparse and hidden data', async () => {
    const accepted = setup((_p, inputs) => {
      assert.deepEqual(inputs, { count: 2n }); return true;
    });
    accepted.attempt.frozenInputs = { count: 2n };
    assert.equal((await attemptDispatchAsync(accepted.deps, accepted.attempt)).status, 'claimed');
    const hidden = Object.defineProperty({}, 'secret', { value: true });
    for (const inputs of [undefined, { value: undefined }, NaN, Infinity, -Infinity, new Array(2), hidden]) {
      const { deps, attempt, order } = setup(() => { throw new Error('must not evaluate'); });
      attempt.frozenInputs = inputs;
      await assert.rejects(attemptDispatchAsync(deps, attempt), /snapshot/);
      assert.deepEqual(order, ['supersession', 'availability']);
    }
  });

  it('keeps concurrent guard executions separate and mints one claim per successful decision', async () => {
    const first = deferred();
    const second = deferred();
    const executions: DispatchGuardExecution[] = [];
    const run = (gate: ReturnType<typeof deferred>) => setup(async (_p, _i, _s, execution) => {
      executions.push(execution); await gate.promise; return true;
    });
    const a = run(first), b = run(second);
    const pa = attemptDispatchAsync(a.deps, a.attempt), pb = attemptDispatchAsync(b.deps, b.attempt);
    assert.notEqual(executions[0], executions[1]);
    first.resolve();
    assert.equal((await pa).status, 'claimed');
    assert.throws(() => readDispatchGuardExecution(executions[0]!), /not live/);
    assertDispatchGuardExecution(executions[1]);
    second.resolve();
    assert.equal((await pb).status, 'claimed');
    assert.equal(a.order.filter(step => step === 'claim').length, 1);
    assert.equal(b.order.filter(step => step === 'claim').length, 1);
  });
});
