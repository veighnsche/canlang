/**
 * S9b-1: kernel table builders/readers round-trip and fail closed.
 * Row builders produce store-valid `StoredRow`s; readers reject any
 * shape drift from the store.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredRow } from '@canlang/contracts';
import {
  KernelTableError,
  WORK_DISPATCH_MODEL,
  WORK_EVERY_SLOT_MODEL,
  WORK_OCCURRENCE_MODEL,
  WORK_SCHEDULE_MODEL,
  WORK_SUPERSESSION_MODEL,
  dispatchByOriginQuery,
  dispatchByStateQuery,
  everySlotRowId,
  newDispatchRow,
  newEverySlotRow,
  newOccurrenceRow,
  newScheduleRow,
  newSupersessionRow,
  readDispatchRow,
  readDispatchImageCorrelation,
  readDispatchImageControlPin,
  dispatchGenerationTargetProfile,
  readEverySlotRow,
  readOccurrenceRow,
  readScheduleRow,
  readSupersessionRow,
  scheduleByKeyQuery,
  scheduleRowScope,
  withRowData,
} from '../src/kernel/tables.js';

const META = { nowMs: 1_758_000_000_000, actor: 'test' };

function rowWithData(data: unknown): StoredRow {
  return {
    id: 'row_1' as StoredRow['id'],
    version: 1 as StoredRow['version'],
    created: META.nowMs,
    updated: META.nowMs,
    createdBy: META.actor,
    updatedBy: META.actor,
    archivedAt: null,
    parent: null,
    data: data as StoredRow['data'],
  };
}

describe('kernel tables: dispatch rows', () => {
  for (const source of ['std.ImagesV1.submit', 'std.TextGenerationV1.generate']) it(`retains ${source} correlation and rejects partial or noncanonical revisions`, () => {
    const correlation = { requestSource: 'arbitrary-business-source', requestRevision: '7',
      requestBinding: 'Acme.Images', requestFrom: 'deployment.images', requestApp: 'Acme', requestOwner: 'team-1' };
    const row = newDispatchRow({ intentId: 'original', operationId: 'different-operation',
      source, occurrenceIndex: 0, originOccurrence: null, ...correlation }, META);
    assert.deepEqual(readDispatchImageCorrelation(readDispatchRow(row)), correlation);
    assert.deepEqual(readDispatchImageCorrelation(readDispatchRow(withRowData(row,
      { ...readDispatchRow(row), state: 'uncertain', attempts: 1 }, META, 'work.dispatch'))), correlation);
    for (const revision of ['07', '-1', '1.0', '', 7, null]) {
      assert.throws(() => readDispatchRow({ ...row, data: { ...row.data, requestRevision: revision } }), KernelTableError);
    }
    for (const missing of Object.keys(correlation)) {
      const data = { ...row.data }; delete data[missing];
      assert.throws(() => readDispatchRow({ ...row, data }), KernelTableError);
    }
    let getters = 0;
    const accessor = { ...correlation };
    Object.defineProperty(accessor, 'requestSource', { get: () => { getters++; return 'bad'; } });
    assert.throws(() => readDispatchImageCorrelation(accessor), KernelTableError);
    assert.equal(getters, 0);
  });

  it('recognizes exactly the two generation families and reads control pins after retained JSON serialization', () => {
    const correlation = { requestSource: 'business-source', requestRevision: '7', requestBinding: 'Acme.Generation',
      requestFrom: 'deployment.generation', requestApp: 'Acme', requestOwner: 'team-1' };
    const pin = { originalIntentId: 'original', observationStartedAtMs: META.nowMs, observationDeadlineMs: META.nowMs + 1000 };
    for (const [original, resultName, family] of [['std.ImagesV1.submit', 'ImageRun', 'images'],
      ['std.TextGenerationV1.generate', 'TextRun', 'text']] as const) {
      assert.deepEqual(dispatchGenerationTargetProfile(original), { family, role: 'original', originalSource: original, resultName });
      for (const action of ['cancel', 'reconcile']) {
        const source = `${original.slice(0, original.lastIndexOf('.'))}.${action}`;
        assert.deepEqual(dispatchGenerationTargetProfile(source), { family, role: 'control', originalSource: original, resultName });
        const row = newDispatchRow({ intentId: 'control', operationId: 'control-operation', source,
          occurrenceIndex: 0, originOccurrence: null, ...correlation }, META);
        const retained = JSON.parse(JSON.stringify({ ...row, data: { ...row.data, ...pin } })) as StoredRow;
        assert.deepEqual(readDispatchImageControlPin(readDispatchRow(retained)), pin);
        assert.throws(() => readDispatchRow({ ...retained, data: { ...retained.data, source: original } }), /disagrees/);
      }
    }
    for (const source of ['std.ImagesV1.generate', 'std.TextGenerationV1.submit', 'std.TextGenerationV2.cancel', 'std.EmailV1.cancel', '__proto__']) {
      assert.equal(dispatchGenerationTargetProfile(source), null);
    }
  });

  it('builds pending producer rows that read back exactly', () => {
    const row = newDispatchRow(
      {
        intentId: 'op_1#0',
        operationId: 'op_1',
        source: 'std.EmailV1.send',
        occurrenceIndex: 0,
        originOccurrence: 'occ_9',
      },
      META,
    );
    assert.equal(row.id, 'op_1#0');
    assert.equal(row.version, 1);
    assert.deepEqual(readDispatchRow(row), {
      intentId: 'op_1#0',
      operationId: 'op_1',
      source: 'std.EmailV1.send',
      occurrenceIndex: 0,
      originOccurrence: 'occ_9',
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
    });
  });

  it('rejects unknown states, bad verdicts and negative attempts', () => {
    const base = readDispatchRow(
      newDispatchRow(
        {
          intentId: 'op_1#0',
          operationId: 'op_1',
          source: 's',
          occurrenceIndex: 0,
          originOccurrence: null,
        },
        META,
      ),
    );
    assert.throws(
      () => readDispatchRow(rowWithData({ ...base, state: 'flying' })),
      KernelTableError,
    );
    assert.throws(
      () => readDispatchRow(rowWithData({ ...base, guardVerdict: 'yes' })),
      KernelTableError,
    );
    assert.throws(
      () => readDispatchRow(rowWithData({ ...base, attempts: -1 })),
      KernelTableError,
    );
    assert.throws(
      () => readDispatchRow(rowWithData({ ...base, claimedAtMs: Number.NaN })),
      KernelTableError,
    );
  });

  it('defaults retryClass to null and rejects unknown classes', () => {
    const row = newDispatchRow(
      {
        intentId: 'op_1#0',
        operationId: 'op_1',
        source: 's',
        occurrenceIndex: 0,
        originOccurrence: null,
      },
      META,
    );
    assert.equal(readDispatchRow(row).retryClass, null);
    const base = readDispatchRow(row);
    assert.throws(
      () => readDispatchRow(rowWithData({ ...base, retryClass: 'sometimes' })),
      KernelTableError,
    );
  });
});

describe('kernel tables: occurrence rows', () => {
  it('round-trips receipts including null-able fields', () => {
    const row = newOccurrenceRow(
      {
        occurrenceId: 'occ_1',
        status: 'failed',
        result: null,
        code: 'transient',
        message: 'boom',
        recordedAtMs: META.nowMs,
      },
      META,
    );
    assert.equal(row.id, 'occ_1');
    assert.deepEqual(readOccurrenceRow(row), {
      occurrenceId: 'occ_1',
      status: 'failed',
      result: null,
      code: 'transient',
      message: 'boom',
      recordedAtMs: META.nowMs,
    });
  });

  it('rejects unknown statuses', () => {
    assert.throws(
      () =>
        readOccurrenceRow(
          rowWithData({ occurrenceId: 'o', status: 'maybe', recordedAtMs: 1 }),
        ),
      KernelTableError,
    );
  });
});

describe('kernel tables: schedule rows', () => {
  it('round-trips lineage with a rebuildable scope', () => {
    const row = newScheduleRow(
      {
        occurrenceId: 'occ_3',
        key: 'reminder',
        scopeApp: 'CanExpense',
        scopeOwner: 'team_1',
        scopeOwnerPackage: 'expense',
        at: META.nowMs,
        event: 'expense.remind',
        payload: { n: 1 },
        replaces: 'occ_2',
        state: 'pending',
      },
      META,
    );
    assert.equal(row.id, 'occ_3');
    const data = readScheduleRow(row);
    assert.deepEqual(scheduleRowScope(data), {
      app: 'CanExpense',
      owner: 'team_1',
      ownerPackage: 'expense',
    });
    assert.deepEqual(data.payload, { n: 1 });
  });

  it('rejects non-record payloads and unknown states', () => {
    assert.throws(
      () =>
        readScheduleRow(
          rowWithData({
            occurrenceId: 'o',
            key: 'k',
            scopeApp: 'a',
            scopeOwner: 't',
            scopeOwnerPackage: 'p',
            at: 1,
            event: 'e',
            payload: [1],
            replaces: null,
            state: 'pending',
          }),
        ),
      KernelTableError,
    );
    assert.throws(
      () =>
        readScheduleRow(
          rowWithData({
            occurrenceId: 'o',
            key: 'k',
            scopeApp: 'a',
            scopeOwner: 't',
            scopeOwnerPackage: 'p',
            at: 1,
            event: 'e',
            payload: {},
            replaces: null,
            state: 'due',
          }),
        ),
      KernelTableError,
    );
  });

  it('round-trips the replaces lineage link', () => {
    const row = newScheduleRow(
      {
        occurrenceId: 'occ_10',
        key: 'reminder',
        scopeApp: 'CanExpense',
        scopeOwner: 'team_1',
        scopeOwnerPackage: 'expense',
        at: META.nowMs,
        event: 'expense.remind',
        payload: {},
        replaces: 'occ_9',
        state: 'pending',
      },
      META,
    );
    assert.equal(readScheduleRow(row).replaces, 'occ_9');
    const fresh = newScheduleRow(
      {
        occurrenceId: 'occ_1',
        key: 'reminder',
        scopeApp: 'CanExpense',
        scopeOwner: 'team_1',
        scopeOwnerPackage: 'expense',
        at: META.nowMs,
        event: 'expense.remind',
        payload: {},
        replaces: null,
        state: 'pending',
      },
      META,
    );
    assert.equal(readScheduleRow(fresh).replaces, null);
    assert.throws(
      () =>
        readScheduleRow(
          rowWithData({ ...readScheduleRow(row), replaces: 7 }),
        ),
      KernelTableError,
    );
  });
});

describe('kernel tables: every-slot and supersession rows', () => {
  it('round-trips slot trackers keyed by app, handler and scope', () => {
    const row = newEverySlotRow(
      {
        scopeKey: 'team:team_1',
        app: 'CanTasks',
        handler: 'TeamTasks.tick',
        scope: 'team',
        owner: 'team_1',
        slot: 42,
      },
      META,
    );
    assert.equal(
      row.id,
      everySlotRowId('CanTasks', 'TeamTasks.tick', 'team', 'team_1'),
    );
    // Exact escaping pin: `/` in components must not collide with separators.
    assert.equal(
      everySlotRowId('CanTasks', 'TeamTasks.tick', 'team', 't/1'),
      'every/v1/CanTasks/TeamTasks.tick/team/t%2F1',
    );
    assert.deepEqual(readEverySlotRow(row).slot, 42);
    assert.throws(
      () =>
        readEverySlotRow(
          rowWithData({
            scopeKey: 'k',
            app: 'a',
            handler: 'h',
            scope: 'root',
            owner: 'o',
            slot: 1,
          }),
        ),
      KernelTableError,
    );
  });

  it('keys tracker ids per app and handler', () => {
    const first = newEverySlotRow(
      {
        scopeKey: 'team:team_1',
        app: 'CanTasks',
        handler: 'A.tick',
        scope: 'team',
        owner: 'team_1',
        slot: 1,
      },
      META,
    );
    const second = newEverySlotRow(
      {
        scopeKey: 'team:team_1',
        app: 'CanTasks',
        handler: 'B.tick',
        scope: 'team',
        owner: 'team_1',
        slot: 1,
      },
      META,
    );
    assert.notEqual(first.id, second.id);
    assert.equal(readEverySlotRow(first).scopeKey, 'team:team_1');
  });

  it('round-trips supersession marks', () => {
    const row = newSupersessionRow(
      { outboxId: 'op_1#0', byOccurrenceId: 'occ_2', markedAtMs: META.nowMs },
      META,
    );
    assert.equal(row.id, 'op_1#0');
    assert.deepEqual(readSupersessionRow(row), {
      outboxId: 'op_1#0',
      byOccurrenceId: 'occ_2',
      markedAtMs: META.nowMs,
    });
  });
});

describe('kernel tables: updates and queries', () => {
  it('withRowData bumps the version with fresh metadata', () => {
    const row = newDispatchRow(
      {
        intentId: 'op_1#0',
        operationId: 'op_1',
        source: 's',
        occurrenceIndex: 0,
        originOccurrence: null,
      },
      META,
    );
    const next = withRowData(
      row,
      { ...readDispatchRow(row), state: 'claimed', claimId: 'c1', claimedAtMs: 5 },
      { nowMs: META.nowMs + 1, actor: 'dispatcher' },
      'work.dispatch',
    );
    assert.equal(next.version, 2);
    assert.equal(next.updated, META.nowMs + 1);
    assert.equal(next.updatedBy, 'dispatcher');
    assert.equal(next.created, META.nowMs);
    assert.equal(readDispatchRow(next).state, 'claimed');
  });

  it('builders reject bad metadata and non-JSON data', () => {
    assert.throws(
      () =>
        newDispatchRow(
          {
            intentId: 'i',
            operationId: 'o',
            source: 's',
            occurrenceIndex: 0,
            originOccurrence: null,
          },
          { nowMs: -1, actor: 't' },
        ),
      KernelTableError,
    );
    assert.throws(
      () =>
        newScheduleRow(
          {
            occurrenceId: 'o',
            key: 'k',
            scopeApp: 'a',
            scopeOwner: 't',
            scopeOwnerPackage: 'p',
            at: 1,
            event: 'e',
            payload: { bad: 7n } as unknown as Record<string, unknown>,
            replaces: null,
            state: 'pending',
          },
          META,
        ),
      KernelTableError,
    );
  });

  it('builders deep-isolate nested staged data', () => {
    const payload = { nested: { n: 1 } };
    const row = newScheduleRow(
      {
        occurrenceId: 'occ_1',
        key: 'reminder',
        scopeApp: 'a',
        scopeOwner: 't',
        scopeOwnerPackage: 'p',
        at: META.nowMs,
        event: 'e',
        payload,
        replaces: null,
        state: 'pending',
      },
      META,
    );
    payload.nested.n = 2;
    assert.deepEqual(readScheduleRow(row).payload, { nested: { n: 1 } });
    const data = readScheduleRow(row);
    const next = withRowData(row, { ...data }, META, 'work.schedule');
    (data.payload['nested'] as Record<string, unknown>)['n'] = 3;
    assert.deepEqual(readScheduleRow(next).payload, { nested: { n: 1 } });
  });

  it('query builders address flat fields on the owned models', () => {
    assert.deepEqual(dispatchByOriginQuery('occ_9'), {
      model: WORK_DISPATCH_MODEL,
      where: { op: 'eq', field: 'originOccurrence', value: 'occ_9' },
      authority: 'owner',
    });
    assert.deepEqual(dispatchByStateQuery('pending'), {
      model: WORK_DISPATCH_MODEL,
      where: { op: 'eq', field: 'state', value: 'pending' },
      authority: 'owner',
    });
    const spec = scheduleByKeyQuery(
      { app: 'A', owner: 'T', ownerPackage: 'P' },
      'reminder',
    );
    assert.equal(spec.model, WORK_SCHEDULE_MODEL);
    assert.deepEqual(spec.where, {
      op: 'and',
      args: [
        { op: 'eq', field: 'key', value: 'reminder' },
        { op: 'eq', field: 'scopeApp', value: 'A' },
        { op: 'eq', field: 'scopeOwner', value: 'T' },
        { op: 'eq', field: 'scopeOwnerPackage', value: 'P' },
      ],
    });
    assert.equal(WORK_OCCURRENCE_MODEL, 'work.occurrence');
    assert.equal(WORK_EVERY_SLOT_MODEL, 'work.every_slot');
    assert.equal(WORK_SUPERSESSION_MODEL, 'work.supersession');
  });
});
