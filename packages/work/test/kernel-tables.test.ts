/**
 * S9b-1: kernel table builders/readers round-trip and fail closed.
 * Row builders produce store-valid `StoredRow`s; readers reject any
 * shape drift from the store.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FrameworkFilePayloadOrigin, ModelName, RecordId, StoredRow } from '@canlang/contracts';
import { RowsKernelError } from '@canlang/work-kernel/rows';
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
  newFanoutCheckpointRow,
  newFanoutChildRow,
  newFanoutIntentRow,
  newOccurrenceRow,
  newScheduleRow,
  newSupersessionRow,
  readDispatchRow,
  readDispatchImageCorrelation,
  readDispatchImageControlPin,
  dispatchGenerationTargetProfile,
  readEverySlotRow,
  readFanoutIntentRow,
  readOccurrenceRow,
  readScheduleRow,
  readSupersessionRow,
  scheduleByKeyQuery,
  scheduleRowScope,
  withRowData,
} from '../src/kernel/tables.js';

const META = { nowMs: 1_758_000_000_000, actor: 'test' };

// Header-codec fixture only: no installed source or genuine File acceptance claim.
function payloadOrigin(model: ModelName, id: string, field: 'result' | 'payload'): FrameworkFilePayloadOrigin {
  return { version: 1, inventory: { owner: 'demo', snapshotId: 'original', digest: 'digest' },
    declarationSetId: 'original-declarations', slot: { model, id: id as RecordId,
      created: META.nowMs, createdBy: META.actor, field,
      role: field === 'result' ? 'retained-result' : 'deferred-input' },
    scope: { app: 'app', owner: 'team-1', ownerPackage: 'demo' },
    origin: { kind: 'event-input', occurrenceId: id, sourceOccurrence: id,
      declaration: { kind: 'declared-event', source: { path: 'demo.can', sha256: 'source', module: 'demo' },
        event: 'demo.changed', inputsDeclarationId: 'event-inputs' },
      lineage: { kind: 'schedule', key: 'key', replaces: null }, target: { kind: 'schedule' } }, files: [] };
}

it('retains detached optional opaque headers and rejects malformed or copied row lifetimes', () => {
  const original = payloadOrigin(WORK_OCCURRENCE_MODEL, 'receipt', 'result');
  const row = newOccurrenceRow({ occurrenceId: 'receipt', status: 'completed', result: { original: ['wire'] },
    code: null, message: null, recordedAtMs: META.nowMs, filePayloadOrigin: original }, META);
  const read = readOccurrenceRow(row);
  assert.deepEqual(read.filePayloadOrigin, original);
  assert.notEqual(read.filePayloadOrigin, row.data['filePayloadOrigin']);
  assert.ok(Object.isFrozen(read.filePayloadOrigin?.origin));
  const advanced = withRowData(row, read as unknown as StoredRow['data'], { nowMs: META.nowMs + 1, actor: 'later' }, 'receipt progress');
  assert.deepEqual(readOccurrenceRow(advanced).filePayloadOrigin, original);
  for (const changed of [
    { ...original, version: 2 }, { ...original, extra: true },
    { ...original, inventory: { owner: 'demo', snapshotId: 'original' } },
    { ...original, scope: { ...original.scope, extra: true } },
    { ...original, slot: { ...original.slot, model: WORK_SCHEDULE_MODEL } },
    { ...original, slot: { ...original.slot, id: 'copy' } },
    { ...original, slot: { ...original.slot, created: META.nowMs + 1 } },
    { ...original, slot: { ...original.slot, createdBy: 'later' } },
    { ...original, slot: { ...original.slot, field: 'payload' } },
    { ...original, slot: { ...original.slot, role: 'deferred-input' } },
    { ...original, origin: { kind: 'unknown' } },
    { ...original, files: [{ path: [-1], file: {} }] },
    { ...original, files: new Array(1) },
  ]) assert.throws(() => readOccurrenceRow({ ...row, data: { ...row.data, filePayloadOrigin: changed } }), KernelTableError);
  let touched = false;
  const getter = { ...original };
  Object.defineProperty(getter, 'origin', { enumerable: true, get() { touched = true; return original.origin; } });
  assert.throws(() => newOccurrenceRow({ ...read, filePayloadOrigin: getter }, META), KernelTableError);
  assert.equal(touched, false);
  assert.throws(() => readOccurrenceRow({ ...row, data: { ...row.data,
    filePayloadOrigin: Object.assign(Object.create({ inherited: true }), original) } }), KernelTableError);
});

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

  it('propagates caller-thrown leaf-class sentinels untouched (identity)', () => {
    // W-REPAIR-010: a caller getter throwing an instance of the public
    // leaf class is NOT a genuine leaf failure: the exact sentinel must
    // propagate, never a projected KernelTableError.
    const sentinel = new RowsKernelError('caller getter sentinel');
    const data = Object.defineProperty({}, 'scope', {
      get() {
        throw sentinel;
      },
    });
    try {
      readEverySlotRow({ data } as StoredRow);
      assert.fail('must throw the caller sentinel');
    } catch (error) {
      assert.equal(error, sentinel);
    }
  });

  it('propagates a retained genuine leaf error rethrown by a caller getter (identity)', () => {
    // W-REPAIR-010 final: a genuine owning error retained from an
    // earlier call and rethrown through a caller getter is a non-leaf
    // throw at this invocation — the exact object must propagate.
    let retained: unknown;
    try {
      readEverySlotRow(
        rowWithData({
          scopeKey: 'k',
          app: 'a',
          handler: 'h',
          scope: 'root',
          owner: 'o',
          slot: 1,
        }),
      );
      assert.fail('must throw');
    } catch (error) {
      retained = error;
    }
    assert.ok(retained instanceof KernelTableError);
    const data = Object.defineProperty({}, 'scope', {
      get() {
        throw retained;
      },
    });
    try {
      readEverySlotRow({ data } as StoredRow);
      assert.fail('must throw the retained error');
    } catch (error) {
      assert.equal(error, retained);
    }
  });

  it('keeps genuine leaf error shape and ignores spoofed brand fields', () => {
    // Genuine leaf failures carry no caller-visible marker…
    try {
      readEverySlotRow(
        rowWithData({
          scopeKey: 'k',
          app: 'a',
          handler: 'h',
          scope: 'root',
          owner: 'o',
          slot: 1,
        }),
      );
      assert.fail('must throw');
    } catch (error) {
      assert.ok(error instanceof KernelTableError);
      assert.ok(!Object.keys(error).includes('__canlangWorkKernelLeafError'));
    }
    // …and a caller-forged marker field never projects.
    const forged = new RowsKernelError('forged marker');
    (forged as unknown as Record<string, unknown>).__canlangWorkKernelLeafError = true;
    const data = Object.defineProperty({}, 'scope', {
      get() {
        throw forged;
      },
    });
    try {
      readEverySlotRow({ data } as StoredRow);
      assert.fail('must throw the forged error');
    } catch (error) {
      assert.equal(error, forged);
    }
  });

  it('projects genuine leaf validation and propagates engine throws', () => {
    // Ordinary leaf validation still projects onto the owning class…
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
      (error: unknown) =>
        error instanceof KernelTableError &&
        (error as Error).message.includes('work.every_slot.scope must be team or app'),
    );
    // …while engine/primitive caller throws propagate as-is.
    const engine = new TypeError('caller engine sentinel');
    const data = Object.defineProperty({}, 'scope', {
      get() {
        throw engine;
      },
    });
    try {
      readEverySlotRow({ data } as StoredRow);
      assert.fail('must throw the engine sentinel');
    } catch (error) {
      assert.equal(error, engine);
    }
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

describe('kernel tables: fanout owning errors (W-011)', () => {
  const META2 = { nowMs: 1, actor: 'a' };
  const INTENT = { sourceOccurrence: 'o', handler: 'h', cohort: 'model' as const, members: ['r', 'r'] };

  it('constructs nested validation failures as the owning error', () => {
    // Reported 011 case: duplicate members fail inside the nested
    // identity-set check, which must carry the factory through.
    try {
      newFanoutIntentRow(INTENT, META2);
      assert.fail('must throw');
    } catch (error) {
      assert.ok(error instanceof KernelTableError);
      assert.ok(!(error instanceof RowsKernelError));
      assert.equal((error as Error).name, 'KernelTableError');
      assert.deepEqual(Object.keys(error), ['name']);
      assert.match((error as Error).message, /duplicate identity/);
    }
  });

  it('constructs nested read failures as the owning error', () => {
    const row = {
      id: 'x', version: 1, created: 1, updated: 1, createdBy: 'a', updatedBy: 'a',
      archivedAt: null, parent: null,
      data: { fanoutId: 'f', sourceOccurrence: 'o', handler: 'h', cohort: 'model', members: ['r', 'r'], memberCount: 2 },
    } as unknown as StoredRow;
    try {
      readFanoutIntentRow(row);
      assert.fail('must throw');
    } catch (error) {
      assert.ok(error instanceof KernelTableError);
      assert.ok(!(error instanceof RowsKernelError));
    }
  });

  it('constructs nested checkpoint/child failures as the owning error', () => {
    try {
      newFanoutCheckpointRow({ fanoutId: 'f', completed: ['c', 'c'], cursor: null }, META2);
      assert.fail('must throw');
    } catch (error) {
      assert.ok(error instanceof KernelTableError);
    }
    try {
      newFanoutChildRow(
        { fanoutId: 'f', parentOccurrence: '', handler: 'h', recordId: 'r', state: 'pending' },
        META2,
      );
      assert.fail('must throw');
    } catch (error) {
      assert.ok(error instanceof KernelTableError);
    }
  });

  it('propagates caller sentinels through nested fanout helpers untouched', () => {
    const sentinel = new RowsKernelError('caller fanout sentinel');
    const input = Object.defineProperty(
      { sourceOccurrence: 'o', handler: 'h', cohort: 'model' },
      'members',
      { get() { throw sentinel; } },
    );
    try {
      newFanoutIntentRow(input as never, META2);
      assert.fail('must throw the caller sentinel');
    } catch (error) {
      assert.equal(error, sentinel);
    }
  });
});
