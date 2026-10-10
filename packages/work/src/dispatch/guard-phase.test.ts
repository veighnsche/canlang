import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitOutboxIntent, stageOutboxIntent } from '../intent/index.js';
import {
  readDispatchGuardExecution, registerDispatchGuardRevalidation, runDispatchGuardPhase,
  type DispatchGuardExecution, type AsyncGuardEvaluator,
} from './index.js';
const intent = commitOutboxIntent(stageOutboxIntent({
  operationId: '0193f2c0-0000-7000-8000-000000000003', source: 'Mail.send',
  occurrenceIndex: 0, request: { to: 'a@test' }, originOccurrence: null,
}), { revision: 3, committedAtMs: 50 });
const phase = (evaluateGuard: AsyncGuardEvaluator) => runDispatchGuardPhase({
  predicate: 'members.current', frozenInputs: { ids: ['a'] }, stateSnapshot: { held: 1 },
  checkpoint: { revision: 4, owner: 'team-a' }, intent, evaluateGuard,
});
test('closed guard evidence transfers without source replay for positive and negative results', async () => {
  for (const result of [true, false]) {
    let execution!: DispatchGuardExecution, evaluations = 0, checks = 0;
    let current = result;
    const pending = await phase((_predicate, _inputs, _state, issued) => {
      execution = issued; evaluations++;
      registerDispatchGuardRevalidation(issued, () => { checks++; return current === result; });
      return result;
    });
    assert.ok(Object.isFrozen(pending)); assert.equal(pending.result, result);
    assert.throws(() => readDispatchGuardExecution(execution), /not live/);
    current = !result;
    assert.equal(await pending.revalidate(), false);
    assert.equal(evaluations, 1); assert.equal(checks, 1);
    await assert.rejects(pending.revalidate(), /already been consumed/);
    assert.equal(checks, 1);
  }
});
test('concurrent evidence consumption poisons the first consumer even when misuse is caught', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = await phase((_predicate, _inputs, _state, execution) => {
    registerDispatchGuardRevalidation(execution, async () => { await gate; return true; });
    return true;
  });
  const first = pending.revalidate();
  await assert.rejects(pending.revalidate(), /already been consumed/);
  release(); await assert.rejects(first, /poisoned/);
});
test('failed evidence cannot be consumed again and reader failures remain exact', async () => {
  const failure = new Error('current reader failed');
  const pending = await phase((_predicate, _inputs, _state, execution) => {
    registerDispatchGuardRevalidation(execution, () => { throw failure; }); return false;
  });
  await assert.rejects(pending.revalidate(), error => error === failure);
  await assert.rejects(pending.revalidate(), /already been consumed/);
});
