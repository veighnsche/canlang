/** S3: keyed schedules — put/replace/cancel with per-occurrence supersession. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OccurrenceId, OutboxItem, WorkScope } from '../../contracts/src/work.js';
import {
  TestOnlyCounterOccurrenceIds,
  TestOnlyMemoryOutboxStore,
  TestOnlyMemoryScheduleStore,
  TestOnlyMemorySupersession,
} from '../src/ports.ts';
import type { NewScheduledOccurrence, ScheduleDeps } from '../src/schedule/index.ts';
import {
  cancelSchedule,
  collectUndispatchedIntents,
  putSchedule,
  replaceSchedule,
} from '../src/schedule/index.ts';

const scope: WorkScope = { app: 'CanApprove', ownerPackage: 'Approval', owner: 'team_1' };

function setup(): ScheduleDeps {
  return {
    schedules: new TestOnlyMemoryScheduleStore(),
    outbox: new TestOnlyMemoryOutboxStore(),
    supersessions: new TestOnlyMemorySupersession(),
    ids: new TestOnlyCounterOccurrenceIds(),
  };
}

function pendingEntry(overrides: Partial<NewScheduledOccurrence> = {}): NewScheduledOccurrence {
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

function outboxItem(
  id: string,
  source: string,
  state: OutboxItem['state'],
  originOccurrence: OccurrenceId | null = null,
): OutboxItem {
  return {
    id,
    operationId: '0193f2c0-0000-7000-8000-000000000001',
    source,
    occurrenceIndex: 0,
    request: {},
    originOccurrence,
    attempts: 0,
    state,
  };
}

describe('schedule: keyed put', () => {
  it('inserts a fresh pending occurrence with a minted id', () => {
    const deps = setup();
    const result = putSchedule(deps, pendingEntry());
    assert.equal(result.admitted.state, 'pending');
    assert.equal(result.admitted.occurrenceId, 'occ_1');
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

  it('freezes record payloads and rejects non-records the fence cannot carry', () => {
    const deps = setup();
    const payload = { noticeId: 'n_1', nested: { tags: ['x'] } };
    const result = putSchedule(deps, pendingEntry({ payload }));
    payload.noticeId = 'mutated';
    payload.nested.tags.push('y');
    assert.deepEqual(result.admitted.payload, {
      noticeId: 'n_1',
      nested: { tags: ['x'] },
    });
    assert.ok(Object.isFrozen(result.admitted.payload));
    for (const bad of [[], 'text', 7, null, undefined, true]) {
      assert.throws(
        () =>
          putSchedule(
            deps,
            pendingEntry({ payload: bad as unknown as Record<string, unknown> }),
          ),
        TypeError,
      );
    }
  });

  it('rejected replacements leave the previous entry and intents untouched', () => {
    const deps = setup();
    const first = putSchedule(deps, pendingEntry());
    deps.outbox.put(
      outboxItem('obx_a', 'Approval.remind', 'pending', first.admitted.occurrenceId),
    );
    assert.throws(
      () =>
        replaceSchedule(
          deps,
          pendingEntry({ payload: ['not', 'a', 'record'] as unknown as Record<string, unknown> }),
        ),
      TypeError,
    );
    assert.equal(deps.schedules.get(scope, 'reminder-1')?.state, 'pending');
    assert.equal(
      deps.schedules.get(scope, 'reminder-1')?.occurrenceId,
      first.admitted.occurrenceId,
    );
    assert.equal(deps.supersessions.isSuperseded('obx_a'), false);
  });
});

describe('schedule: replace supersedes pending occurrences', () => {
  it('supersedes the previous pending occurrence and returns its id', () => {
    const deps = setup();
    const first = putSchedule(deps, pendingEntry());
    const result = replaceSchedule(deps, pendingEntry({ at: 1_791_130_000_000 }));
    assert.equal(result.superseded?.state, 'superseded');
    assert.equal(result.supersededId, first.admitted.occurrenceId);
    assert.equal(result.admitted.state, 'pending');
    assert.equal(result.admitted.at, 1_791_130_000_000);
    // The replacement is a new occurrence with its own id.
    assert.notEqual(result.admitted.occurrenceId, first.admitted.occurrenceId);
  });

  it('put over a pending key is also a replace', () => {
    const deps = setup();
    const first = putSchedule(deps, pendingEntry());
    const result = putSchedule(deps, pendingEntry({ payload: { noticeId: 'n_2' } }));
    assert.equal(result.superseded?.state, 'superseded');
    assert.equal(result.supersededId, first.admitted.occurrenceId);
  });

  it('supersedes undispatched delivery intents and returns their ids', () => {
    const deps = setup();
    const put = putSchedule(deps, pendingEntry());
    const origin = put.admitted.occurrenceId;
    deps.outbox.put(outboxItem('obx_b', 'Approval.remind', 'pending', origin));
    deps.outbox.put(outboxItem('obx_a', 'Approval.remind', 'pending', origin));
    // Capability-sourced sends of the same occurrence join too.
    deps.outbox.put(outboxItem('obx_mail', 'Mail.send', 'pending', origin));
    deps.outbox.put(outboxItem('obx_other', 'Approval.digest', 'pending', 'occ_foreign'));
    const result = replaceSchedule(deps, pendingEntry({ at: 1_791_130_000_000 }));
    assert.deepEqual(result.affectedOutboxIds, ['obx_a', 'obx_b', 'obx_mail']);
    assert.equal(deps.supersessions.isSuperseded('obx_a'), true);
    assert.equal(deps.supersessions.isSuperseded('obx_b'), true);
    assert.equal(deps.supersessions.isSuperseded('obx_mail'), true);
    assert.equal(deps.supersessions.isSuperseded('obx_other'), false);
  });

  it('never touches provider-accepted work: claimed/uncertain/settled items complete', () => {
    const deps = setup();
    const put = putSchedule(deps, pendingEntry());
    const origin = put.admitted.occurrenceId;
    for (const [id, state] of [
      ['obx_claimed', 'claimed'],
      ['obx_uncertain', 'uncertain'],
      ['obx_delivered', 'delivered'],
      ['obx_failed', 'failed'],
      ['obx_dead', 'dead'],
    ] as const) {
      deps.outbox.put(outboxItem(id, 'Approval.remind', state, origin));
    }
    deps.outbox.put(outboxItem('obx_pending', 'Approval.remind', 'pending', origin));
    const result = replaceSchedule(deps, pendingEntry({ at: 1_791_130_000_000 }));
    assert.deepEqual(result.affectedOutboxIds, ['obx_pending']);
    for (const id of ['obx_claimed', 'obx_uncertain', 'obx_delivered', 'obx_failed', 'obx_dead']) {
      assert.equal(deps.supersessions.isSuperseded(id), false);
    }
    // Provider-accepted work is undisturbed and may still complete.
    assert.equal(deps.outbox.get('obx_claimed')?.state, 'claimed');
    assert.equal(deps.outbox.get('obx_uncertain')?.state, 'uncertain');
  });

  it('isolates same-event keys: cancelling one never skips another', () => {
    const deps = setup();
    const first = putSchedule(deps, pendingEntry({ key: 'reminder-a' }));
    const second = putSchedule(deps, pendingEntry({ key: 'reminder-b' }));
    deps.outbox.put(outboxItem('obx_a', 'Mail.send', 'pending', first.admitted.occurrenceId));
    deps.outbox.put(outboxItem('obx_b', 'Mail.send', 'pending', second.admitted.occurrenceId));
    const result = cancelSchedule(deps, scope, 'reminder-a');
    assert.deepEqual(result.affectedOutboxIds, ['obx_a']);
    assert.equal(deps.supersessions.isSuperseded('obx_a'), true);
    assert.equal(deps.supersessions.isSuperseded('obx_b'), false);
  });

  it('collects undispatched intents by exact occurrence match only', () => {
    const deps = setup();
    deps.outbox.put(outboxItem('obx_1', 'Approval.remind', 'pending', 'occ_1'));
    deps.outbox.put(outboxItem('obx_2', 'Approval.remind', 'pending', 'occ_1b'));
    deps.outbox.put(outboxItem('obx_3', 'Approval.remind', 'pending', null));
    const found = collectUndispatchedIntents(deps.outbox, 'occ_1');
    assert.deepEqual(found.map((item) => item.id), ['obx_1']);
  });
});

describe('schedule: cancel', () => {
  it('cancels a pending occurrence and supersedes its undispatched intents', () => {
    const deps = setup();
    const put = putSchedule(deps, pendingEntry());
    deps.outbox.put(outboxItem('obx_1', 'Approval.remind', 'pending', put.admitted.occurrenceId));
    const result = cancelSchedule(deps, scope, 'reminder-1');
    assert.equal(result.cancelled?.state, 'cancelled');
    assert.deepEqual(result.affectedOutboxIds, ['obx_1']);
    assert.equal(deps.supersessions.isSuperseded('obx_1'), true);
    assert.equal(deps.schedules.get(scope, 'reminder-1')?.state, 'cancelled');
  });

  it('marks admitted entries cancelled while in-flight work may complete', () => {
    const deps = setup();
    deps.schedules.put({ ...pendingEntry(), state: 'admitted', occurrenceId: 'occ_live' });
    deps.outbox.put(outboxItem('obx_live', 'Approval.remind', 'claimed', 'occ_live'));
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
