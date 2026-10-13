/**
 * BGI-08 computed-key producer join tests (colocated): the State-owned
 * `state.unique-key@1` evaluation discipline (projected text in, checked
 * text out, active-call/closed-scope/retained-failure rules), old/final
 * diffing into canonical claims/releases, and the installation/
 * changed-code activation planner. The saved-export fixture mirrors the
 * BGI-07 canonical-identity implementation (`NFKC` + lowercase); State
 * checks text-ness, never the spelling semantics.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelName, RecordId } from '@canlang/contracts';
import { StateError } from '../errors.js';
import {
  createGivenUniqueKeyScope,
  diffGivenUniqueKeys,
  givenUniqueKeyName,
  planGivenUniqueKeyInstall,
  type GivenUniqueKeyRule,
} from './staging.js';

const MODEL = 'Tasks.Account' as ModelName;
const RULE = 'Tasks.Account.handle#canonical_identity';

/** Saved-implementation fixture: NFKC-normalize, then lowercase. */
function canonicalKey(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function rule(overrides: Partial<GivenUniqueKeyRule> = {}): GivenUniqueKeyRule {
  return { rule: RULE, field: 'handle', evaluate: canonicalKey, ...overrides };
}

async function captureStateError(run: () => unknown): Promise<StateError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof StateError, `expected StateError, got ${(error as Error)?.message}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected StateError' });
}

describe('BGI-08 computed-key evaluation scope', () => {
  it('projects exact text to the saved export and checks exact text out', async () => {
    const seen: unknown[] = [];
    const scope = createGivenUniqueKeyScope();
    const key = await scope.evaluate(
      rule({ evaluate: (value) => { seen.push(value); return canonicalKey(value); } }),
      'Ａlice',
    );
    assert.equal(key, 'alice');
    assert.deepEqual(seen, ['Ａlice']);
    assert.equal(typeof seen[0], 'string');
  });

  it('skips null/undefined without calling the saved export', async () => {
    let calls = 0;
    const scope = createGivenUniqueKeyScope();
    const counting = rule({ evaluate: (value) => { calls += 1; return value; } });
    assert.equal(await scope.evaluate(counting, null), null);
    assert.equal(await scope.evaluate(counting, undefined), null);
    assert.equal(calls, 0);
  });

  it('rejects non-text input with the rule identity', async () => {
    const scope = createGivenUniqueKeyScope();
    for (const value of [42, true, {}, ['x']]) {
      const error = await captureStateError(() => scope.evaluate(rule(), value));
      assert.equal(error.code, 'validation');
      assert.match(error.message, /Tasks\.Account\.handle#canonical_identity/);
      assert.match(error.message, /input must be text/);
    }
  });

  it('rejects non-text results with the rule identity', async () => {
    const scope = createGivenUniqueKeyScope();
    const error = await captureStateError(() =>
      scope.evaluate(rule({ evaluate: () => 42 as unknown as string }), 'Bob'),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /result must be text/);
  });

  it('wraps saved-export throws as canonical failures and retains them', async () => {
    let calls = 0;
    const scope = createGivenUniqueKeyScope();
    const failing = rule({
      evaluate: () => { calls += 1; throw new Error('boom'); },
    });
    const first = await captureStateError(() => scope.evaluate(failing, 'Bob'));
    assert.equal(first.code, 'validation');
    assert.match(first.message, /saved export failed: boom/);
    // Retained: the second evaluation rethrows the SAME failure without
    // rerunning generated behavior.
    const second = await captureStateError(() => scope.evaluate(failing, 'Alice'));
    assert.equal(second, first);
    assert.equal(calls, 1);
  });

  it('retains async rejections the same way', async () => {
    let calls = 0;
    const scope = createGivenUniqueKeyScope();
    const failing = rule({
      evaluate: async () => { calls += 1; throw new Error('async boom'); },
    });
    const first = await captureStateError(() => scope.evaluate(failing, 'Bob'));
    assert.equal(first.code, 'validation');
    assert.match(first.message, /async boom/);
    const second = await captureStateError(() => scope.evaluate(failing, 'Alice'));
    assert.equal(second, first);
    assert.equal(calls, 1);
  });

  it('refuses evaluation after close as a late call', async () => {
    const scope = createGivenUniqueKeyScope();
    assert.equal(await scope.evaluate(rule(), 'Bob'), 'bob');
    scope.close();
    const error = await captureStateError(() => scope.evaluate(rule(), 'Bob'));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /late call/);
  });

  it('refuses overlapping evaluations', async () => {
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const scope = createGivenUniqueKeyScope();
    const gated = rule({ evaluate: () => gate });
    const pending = scope.evaluate(gated, 'Bob');
    const error = await captureStateError(() => scope.evaluate(rule(), 'Alice'));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /overlaps an in-flight evaluation/);
    release('bob');
    assert.equal(await pending, 'bob');
  });
});

describe('BGI-08 computed-key diffing', () => {
  const RECORD = 'r1' as RecordId;

  it('owns the claim namespace off the compiler-owned rule', () => {
    assert.equal(givenUniqueKeyName(RULE), `given:${RULE}`);
  });

  it('claims the final key on create and preserves no stored spelling', async () => {
    const scope = createGivenUniqueKeyScope();
    const diff = await diffGivenUniqueKeys(scope, [rule()], MODEL, RECORD, null, { handle: 'Ａlice' });
    assert.deepEqual(diff.releases, []);
    assert.deepEqual(diff.claims, [{
      model: MODEL,
      keyName: `given:${RULE}`,
      keyValue: 'alice',
      recordId: RECORD,
    }]);
  });

  it('skips unchanged keys and moves changed ones', async () => {
    const scope = createGivenUniqueKeyScope();
    const same = await diffGivenUniqueKeys(
      scope, [rule()], MODEL, RECORD, { handle: 'Alice' }, { handle: 'Ａlice' },
    );
    assert.deepEqual(same.claims, []);
    assert.deepEqual(same.releases, []);
    const moved = await diffGivenUniqueKeys(
      scope, [rule()], MODEL, RECORD, { handle: 'Alice' }, { handle: 'Bob' },
    );
    assert.deepEqual(moved.releases, [{ model: MODEL, keyName: `given:${RULE}`, keyValue: 'alice' }]);
    assert.deepEqual(moved.claims, [{
      model: MODEL, keyName: `given:${RULE}`, keyValue: 'bob', recordId: RECORD,
    }]);
  });

  it('releases the old key on remove', async () => {
    const scope = createGivenUniqueKeyScope();
    const diff = await diffGivenUniqueKeys(scope, [rule()], MODEL, RECORD, { handle: 'Bob' }, null);
    assert.deepEqual(diff.claims, []);
    assert.deepEqual(diff.releases, [{ model: MODEL, keyName: `given:${RULE}`, keyValue: 'bob' }]);
  });

  it('skips null sides and evaluates rules in order', async () => {
    const order: string[] = [];
    const scope = createGivenUniqueKeyScope();
    const first = rule({
      rule: 'Tasks.Account.handle#first',
      evaluate: (value) => { order.push('first'); return canonicalKey(value); },
    });
    const second = rule({
      rule: 'Tasks.Account.handle#second',
      evaluate: (value) => { order.push('second'); return canonicalKey(value); },
    });
    const diff = await diffGivenUniqueKeys(scope, [first, second], MODEL, RECORD, null, { handle: 'Bob' });
    assert.deepEqual(order, ['first', 'second']);
    assert.equal(diff.claims.length, 2);
    const empty = await diffGivenUniqueKeys(scope, [first], MODEL, RECORD, null, { handle: null });
    assert.deepEqual(empty.claims, []);
    assert.deepEqual(empty.releases, []);
  });
});

describe('BGI-08 installation and changed-code activation planning', () => {
  const rules = new Map([[MODEL, [rule()]]]);

  it('plans canonical claims for installed rows', async () => {
    const { claims } = await planGivenUniqueKeyInstall(rules, [
      { model: MODEL, id: 'a' as RecordId, data: { handle: 'Alice' } },
      { model: MODEL, id: 'b' as RecordId, data: { handle: 'Bob' } },
    ]);
    assert.deepEqual(claims, [
      { model: MODEL, keyName: `given:${RULE}`, keyValue: 'alice', recordId: 'a' },
      { model: MODEL, keyName: `given:${RULE}`, keyValue: 'bob', recordId: 'b' },
    ]);
  });

  it('reports installed collisions as conflict before anything commits', async () => {
    const error = await captureStateError(() => planGivenUniqueKeyInstall(rules, [
      { model: MODEL, id: 'a' as RecordId, data: { handle: 'Ａlice' } },
      { model: MODEL, id: 'b' as RecordId, data: { handle: 'Alice' } },
    ]));
    assert.equal(error.code, 'conflict');
    assert.match(error.message, /collides on installed rows/);
    assert.match(error.message, /"a" and "b"/);
  });

  it('changed code that newly collides fails activation and plans nothing', async () => {
    const changed = new Map([[MODEL, [rule({ evaluate: () => 'same' })]]]);
    const error = await captureStateError(() => planGivenUniqueKeyInstall(changed, [
      { model: MODEL, id: 'a' as RecordId, data: { handle: 'Alice' } },
      { model: MODEL, id: 'b' as RecordId, data: { handle: 'Bob' } },
    ]));
    assert.equal(error.code, 'conflict');
    // The planner mutates nothing: planning with the prior evaluator still
    // yields the prior claims (failed activation retains prior claims).
    const { claims } = await planGivenUniqueKeyInstall(rules, [
      { model: MODEL, id: 'a' as RecordId, data: { handle: 'Alice' } },
      { model: MODEL, id: 'b' as RecordId, data: { handle: 'Bob' } },
    ]);
    assert.equal(claims.length, 2);
  });

  it('skips rows and models without keys', async () => {
    const { claims } = await planGivenUniqueKeyInstall(rules, [
      { model: MODEL, id: 'a' as RecordId, data: { handle: null } },
      { model: 'Tasks.Other' as ModelName, id: 'b' as RecordId, data: { handle: 'Alice' } },
    ]);
    assert.deepEqual(claims, []);
  });
});
