/** S3: keyed schedules — put/replace/cancel with supersession. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OutboxItem, ScheduledOccurrence, WorkScope } from '../../contracts/src/work.js';
import {
  TestOnlyMemoryOutboxStore,
  TestOnlyMemoryScheduleStore,
  TestOnlyMemorySupersession,
} from '../src/ports.ts';
import type { ScheduleDeps } from '../src/schedule/index.ts';
import {
  cancelSchedule,
  collectUndispatchedIntents,
  formatScheduleId,
  putSchedule,
  replaceSchedule,
} from '../src/schedule/index.ts';

const scope: WorkScope = { app: 'CanApprove', ownerPackage: 'Approval', owner: 'team_1' };

function setup(): ScheduleDeps {
  return {
    schedules: new TestOnlyMemoryScheduleStore(),
    outbox: new TestOnlyMemoryOutboxStore(),
    supersessions: new TestOnlyMemorySupersession(),
  };
}

function pendingEntry(overrides: Partial<ScheduledOccurrence> = {}): ScheduledOccurrence {
  return {
    key: 'reminder-1',
    scope,
    at: 1_791_120_000_000,
    event: 'Approval.remind',
    payload: { noticeId: 'n_1' },
    state: 'pending',
    ...overrides,
  };
}

function outboxItem(id: string, source: string, state: OutboxItem['state']): OutboxItem {
  return {
    id,
    operationId: '0193f2c0-0000-7000-8000-000000000001',
    source,
    occurrenceIndex: 0,
    request: {},
    attempts: 0,
    state,
  };
}

describe('schedule: keyed put', () => {
  it('inserts a fresh pending occurrence', () => {
    const deps = setup();
    const result = putSchedule(deps, pendingEntry());
    assert.equal(result.admitted.state, 'pending');
    assert.equal(result.superseded, null);
    assert.equal(result.supersededId, null);
    assert.deepEqual(result.affectedOutboxIds, []);
    assert.deepEqual(deps.schedules.get(scope, 'reminder-1'), result.admitted);
  });

  it('rejects non-pending and malformed entries', () => {
    const deps = setup();
    assert.throws(() => putSchedule(deps, { ...pendingEntry(), state: 'admitted' }), RangeError);
    assert.throws(() => putSchedule(deps, pendingEntry({ key: '' })), RangeError);
    assert.throws(() => putSchedule(deps, pendingEntry({ event: '' })), RangeError);
  });
});

describe('schedule: replace supersedes pending occurrences', () => {
  it('supersedes the previous pending occurrence and returns its id', () => {
    const deps = setup();
    putSchedule(deps, pendingEntry());
    const result = replaceSchedule(deps, pendingEntry({ at: 1_791_130_000_000 }));
    assert.equal(result.superseded?.state, 'superseded');
    assert.equal(result.supersededId, formatScheduleId(scope, 'reminder-1'));
    assert.equal(result.admitted.state, 'pending');
    assert.equal(result.admitted.at, 1_791_130_000_000);
  });

  it('put over a pending key is also a replace', () => {
    const deps = setup();
    putSchedule(deps, pendingEntry());
    const result = putSchedule(deps, pendingEntry({ payload: { noticeId: 'n_2' } }));
    assert.equal(result.superseded?.state, 'superseded');
    assert.equal(result.supersededId, 'CanApprove|team_1|Approval|reminder-1');
  });

  it('supersedes undispatched delivery intents and returns their ids', () => {
    const deps = setup();
    putSchedule(deps, pendingEntry());
    deps.outbox.put(outboxItem('obx_b', 'Approval.remind', 'pending'));
    deps.outbox.put(outboxItem('obx_a', 'Approval.remind', 'pending'));
    deps.outbox.put(outboxItem('obx_other', 'Approval.digest', 'pending'));
    const result = replaceSchedule(deps, pendingEntry({ at: 1_791_130_000_000 }));
    assert.deepEqual(result.affectedOutboxIds, ['obx_a', 'obx_b']);
    assert.equal(deps.supersessions.isSuperseded('obx_a'), true);
    assert.equal(deps.supersessions.isSuperseded('obx_b'), true);
    assert.equal(deps.supersessions.isSuperseded('obx_other'), false);
  });

  it('never touches provider-accepted work: claimed/uncertain/settled items complete', () => {
    const deps = setup();
    putSchedule(deps, pendingEntry());
    for (const [id, state] of [
      ['obx_claimed', 'claimed'],
      ['obx_uncertain', 'uncertain'],
      ['obx_delivered', 'delivered'],
      ['obx_failed', 'failed'],
      ['obx_dead', 'dead'],
    ] as const) {
      deps.outbox.put(outboxItem(id, 'Approval.remind', state));
    }
    deps.outbox.put(outboxItem('obx_pending', 'Approval.remind', 'pending'));
    const result = replaceSchedule(deps, pendingEntry({ at: 1_791_130_000_000 }));
    assert.deepEqual(result.affectedOutboxIds, ['obx_pending']);
    for (const id of ['obx_claimed', 'obx_uncertain', 'obx_delivered', 'obx_failed', 'obx_dead']) {
      assert.equal(deps.supersessions.isSuperseded(id), false);
    }
    // Provider-accepted work is undisturbed and may still complete.
    assert.equal(deps.outbox.get('obx_claimed')?.state, 'claimed');
    assert.equal(deps.outbox.get('obx_uncertain')?.state, 'uncertain');
  });

  it('collects undispatched intents by exact source match only', () => {
    const deps = setup();
    deps.outbox.put(outboxItem('obx_1', 'Approval.remind', 'pending'));
    deps.outbox.put(outboxItem('obx_2', 'Approval.remind.extra', 'pending'));
    const found = collectUndispatchedIntents(deps.outbox, 'Approval.remind');
    assert.deepEqual(found.map((item) => item.id), ['obx_1']);
  });
});

describe('schedule: cancel', () => {
  it('cancels a pending occurrence and supersedes its undispatched intents', () => {
    const deps = setup();
    putSchedule(deps, pendingEntry());
    deps.outbox.put(outboxItem('obx_1', 'Approval.remind', 'pending'));
    const result = cancelSchedule(deps, scope, 'reminder-1');
    assert.equal(result.cancelled?.state, 'cancelled');
    assert.deepEqual(result.affectedOutboxIds, ['obx_1']);
    assert.equal(deps.supersessions.isSuperseded('obx_1'), true);
    assert.equal(deps.schedules.get(scope, 'reminder-1')?.state, 'cancelled');
  });

  it('marks admitted entries cancelled while in-flight work may complete', () => {
    const deps = setup();
    deps.schedules.put({ ...pendingEntry(), state: 'admitted' });
    deps.outbox.put(outboxItem('obx_live', 'Approval.remind', 'claimed'));
    const result = cancelSchedule(deps, scope, 'reminder-1');
    assert.equal(result.cancelled?.state, 'cancelled');
    assert.deepEqual(result.affectedOutboxIds, []);
    assert.equal(deps.outbox.get('obx_live')?.state, 'claimed');
    assert.equal(deps.supersessions.isSuperseded('obx_live'), false);
  });

  it('cancel is idempotent over missing and terminal keys', () => {
    const deps = setup();
    assert.deepEqual(cancelSchedule(deps, scope, 'missing'), {
      cancelled: null,
      affectedOutboxIds: [],
    });
    putSchedule(deps, pendingEntry());
    cancelSchedule(deps, scope, 'reminder-1');
    const again = cancelSchedule(deps, scope, 'reminder-1');
    assert.equal(again.cancelled?.state, 'cancelled');
    assert.deepEqual(again.affectedOutboxIds, []);
  });
});
