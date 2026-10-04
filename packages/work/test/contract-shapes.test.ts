/**
 * S2 conformance: work contract shapes accept their documented fixtures.
 * Compile-time assignability plus runtime shape assertions; behavior tests
 * land with the `@canlang/work` implementation (S3+).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  CommittedChangeEvent,
  DispatchClaim,
  DispatchGuardRef,
  GuardVerdict,
  OutboxItem,
  PendingWorkInventory,
  ReceiptObservation,
  RecurringOccurrence,
  RetryPolicy,
  ScheduledOccurrence,
  WorkScope,
} from '../../contracts/src/work.js';

const scope: WorkScope = {
  app: 'CanApprove',
  ownerPackage: 'Approval',
  owner: 'team_1',
};

describe('work contracts', () => {
  it('models a committed change event as immutable identities', () => {
    const event: CommittedChangeEvent = {
      recordId: 'rec_1',
      owner: 'team_1',
      version: 3,
      occurrenceId: 'occ_1',
    };
    assert.equal(event.version, 3);
    assert.equal(event.occurrenceId, 'occ_1');
  });

  it('models a keyed scheduled occurrence with owner scope', () => {
    const occurrence: ScheduledOccurrence = {
      key: 'reminder-1',
      scope,
      at: 1791120000000,
      event: 'Approval.remind',
      payload: { noticeId: 'n_1' },
      state: 'pending',
    };
    assert.equal(occurrence.key, 'reminder-1');
    assert.equal(occurrence.scope.ownerPackage, 'Approval');
  });

  it('models a recurring occurrence with app, handler, owner and slot', () => {
    const occurrence: RecurringOccurrence = {
      occurrenceId: 'occ_every_1',
      app: 'CanApprove',
      handler: 'Approval.digest',
      scope: 'team',
      owner: 'team_1',
      slot: 1791120000,
    };
    assert.equal(occurrence.slot, 1791120000);
  });

  it('derives outbox identity from operation, source and index', () => {
    const item: OutboxItem = {
      id: 'obx_1',
      operationId: '0193f2c0-0000-7000-8000-000000000001',
      source: 'Mail.send',
      occurrenceIndex: 0,
      request: { to: 'reviewer@example.test', subject: 'Review' },
      attempts: 0,
      state: 'pending',
    };
    assert.equal(item.occurrenceIndex, 0);
    assert.equal(item.state, 'pending');
  });

  it('models dispatch claims and guard verdicts', () => {
    const claim: DispatchClaim = {
      outboxId: 'obx_1',
      claimId: 'claim_1',
      claimedAt: 1791120000000,
    };
    const guard: DispatchGuardRef = { predicate: 'notice.kind == decision' };
    const unconditional: DispatchGuardRef = { predicate: null };
    const verdict: GuardVerdict = { outboxId: 'obx_1', result: false };
    assert.equal(claim.claimId, 'claim_1');
    assert.equal(unconditional.predicate, null);
    assert.equal(guard.predicate, 'notice.kind == decision');
    assert.equal(verdict.result, false);
  });

  it('observes receipts with revision, status, result and closed error', () => {
    const observed: ReceiptObservation = {
      id: 'del_1',
      revision: 42,
      status: 'failed',
      result: null,
      error: { code: 'provider', message: 'Delivery rejected' },
    };
    assert.equal(observed.id, 'del_1');
    assert.equal(observed.revision, 42);
    assert.deepEqual(Object.keys(observed.error ?? {}).sort(), [
      'code',
      'message',
    ]);
  });

  it('summarizes pending work for recovery hooks', () => {
    const inventory: PendingWorkInventory = {
      outboxPending: 2,
      outboxClaimed: 1,
      outboxUncertain: 1,
      outboxDead: 0,
      dueOccurrences: 3,
      oldestUncertainAt: 1791110000000,
    };
    const policy: RetryPolicy = { maxAttempts: 8, horizonMs: 86_400_000 };
    assert.equal(inventory.outboxUncertain, 1);
    assert.equal(policy.maxAttempts, 8);
  });
});
