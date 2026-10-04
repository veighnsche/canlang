/** S3: staged intents — stable ids, frozen requests, commit gate. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  commitOutboxIntent,
  deriveOutboxId,
  freezeRequest,
  isCommitted,
  requireCommitted,
  stageOutboxIntent,
} from '../src/intent/index.ts';

const OPERATION = '0193f2c0-0000-7000-8000-000000000001';

describe('intent: stable outbox-id derivation', () => {
  it('derives the same id for the same inputs', () => {
    const a = deriveOutboxId(OPERATION, 'Mail.send', 0);
    const b = deriveOutboxId(OPERATION, 'Mail.send', 0);
    assert.equal(a, b);
    assert.match(a, /^obx_[0-9a-f]{64}$/);
  });

  it('derives distinct ids per occurrence index, source and operation', () => {
    const base = deriveOutboxId(OPERATION, 'Mail.send', 0);
    assert.notEqual(deriveOutboxId(OPERATION, 'Mail.send', 1), base);
    assert.notEqual(deriveOutboxId(OPERATION, 'Sms.send', 0), base);
    assert.notEqual(deriveOutboxId('0193f2c0-0000-7000-8000-000000000002', 'Mail.send', 0), base);
  });

  it('rejects empty identities and negative indexes', () => {
    assert.throws(() => deriveOutboxId('', 'Mail.send', 0), RangeError);
    assert.throws(() => deriveOutboxId(OPERATION, '', 0), RangeError);
    assert.throws(() => deriveOutboxId(OPERATION, 'Mail.send', -1), RangeError);
    assert.throws(() => deriveOutboxId(OPERATION, 'Mail.send', 1.5), RangeError);
  });
});

describe('intent: frozen-request builder', () => {
  it('deep-freezes the built request', () => {
    const frozen = freezeRequest({ to: 'a@test', nested: { tags: ['x'] } }) as {
      nested: { tags: string[] };
    };
    assert.ok(Object.isFrozen(frozen));
    assert.ok(Object.isFrozen(frozen.nested));
    assert.ok(Object.isFrozen(frozen.nested.tags));
    assert.throws(() => {
      frozen.nested.tags.push('y');
    }, TypeError);
  });

  it('clones so later caller mutation cannot leak in', () => {
    const input = { subject: 'before' };
    const frozen = freezeRequest(input) as { subject: string };
    input.subject = 'after';
    assert.equal(frozen.subject, 'before');
  });

  it('rejects uncloneable requests', () => {
    assert.throws(() => freezeRequest({ fn: () => 1 }));
  });
});

describe('intent: commit gate', () => {
  it('stages intents without a commit marker', () => {
    const staged = stageOutboxIntent({
      operationId: OPERATION,
      source: 'Mail.send',
      occurrenceIndex: 0,
      request: { to: 'a@test' },
    });
    assert.equal(staged.commit, null);
    assert.equal(staged.item.attempts, 0);
    assert.equal(staged.item.state, 'pending');
    assert.equal(staged.item.id, deriveOutboxId(OPERATION, 'Mail.send', 0));
    assert.ok(Object.isFrozen(staged.item.request));
    assert.equal(isCommitted(staged), false);
  });

  it('refuses staged intents at the gate but passes committed ones', () => {
    const staged = stageOutboxIntent({
      operationId: OPERATION,
      source: 'Mail.send',
      occurrenceIndex: 0,
      request: {},
    });
    assert.throws(() => requireCommitted(staged), /not committed; dispatch refused/);
    const committed = commitOutboxIntent(staged, { revision: 7, committedAtMs: 1000 });
    assert.equal(isCommitted(committed), true);
    assert.equal(requireCommitted(committed), committed);
    assert.deepEqual(committed.commit, { revision: 7, committedAtMs: 1000 });
  });

  it('rejects invalid commit markers', () => {
    const staged = stageOutboxIntent({
      operationId: OPERATION,
      source: 'Mail.send',
      occurrenceIndex: 0,
      request: {},
    });
    assert.throws(() => commitOutboxIntent(staged, { revision: 0, committedAtMs: 1 }), RangeError);
    assert.throws(() => commitOutboxIntent(staged, { revision: 1, committedAtMs: -1 }), RangeError);
  });
});
