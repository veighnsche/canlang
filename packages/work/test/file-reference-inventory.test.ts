/** Owning row shapes and opaque roles only; no File authority or issuer grant. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelName, StoredRow } from '@canlang/contracts';
import { WORK_FILE_REFERENCE_PRODUCER as producer } from '../src/kernel/file-reference-inventory.js';
import {
  WORK_DISPATCH_MODEL, WORK_OCCURRENCE_MODEL, WORK_SCHEDULE_MODEL, WORK_EVERY_SLOT_MODEL,
  WORK_SUPERSESSION_MODEL, WORK_FANOUT_INTENT_MODEL, WORK_FANOUT_CHECKPOINT_MODEL, WORK_FANOUT_CHILD_MODEL,
  newDispatchRow, newOccurrenceRow, newScheduleRow, newEverySlotRow, newSupersessionRow,
  newFanoutIntentRow, newFanoutCheckpointRow, newFanoutChildRow,
} from '../src/kernel/tables.js';
import { WORK_HANDLER_OCCURRENCE_MODEL, stageHandlerOccurrence } from '../src/kernel/handler-occurrence.js';

const meta = { nowMs: 100, actor: 'owner-host' };
async function rows(): Promise<Array<readonly [ModelName, StoredRow]>> {
  const intent = newFanoutIntentRow({ sourceOccurrence: 'source-1', handler: 'demo.handler', cohort: 'model', members: ['a', 'b'] }, meta);
  const handler = await stageHandlerOccurrence({ source: { occurrenceId: 'source-1', event: 'demo.Event',
    payload: { file: 'file-like-value' }, scope: { app: 'app', owner: 'team', ownerPackage: 'demo' } }, handler: 'demo.handler' },
  { actor: meta.actor, now: meta.nowMs, operation: 'checked-intake', load: async () => null,
    query: async () => { throw new Error('unexpected query'); } });
  assert.equal(handler.status, 'ready');
  if (handler.status !== 'ready') throw new Error('actual handler staging refused');
  return [
    [WORK_DISPATCH_MODEL, newDispatchRow({ intentId: 'outbox-1', operationId: 'operation-1', source: 'demo.send', occurrenceIndex: 0, originOccurrence: null }, meta)],
    [WORK_OCCURRENCE_MODEL, newOccurrenceRow({ occurrenceId: 'occurrence-1', status: 'completed', result: { file: 'file-like-value' }, code: null, message: null, recordedAtMs: 100 }, meta)],
    [WORK_SCHEDULE_MODEL, newScheduleRow({ occurrenceId: 'schedule-1', key: 'key', scopeApp: 'app', scopeOwner: 'team', scopeOwnerPackage: 'demo', at: 200, event: 'demo.Event', payload: { file: 'file-like-value' }, replaces: null, state: 'pending' }, meta)],
    [WORK_EVERY_SLOT_MODEL, newEverySlotRow({ scopeKey: 'team/team', app: 'app', handler: 'demo.tick', scope: 'team', owner: 'team', slot: 1 }, meta)],
    [WORK_SUPERSESSION_MODEL, newSupersessionRow({ outboxId: 'outbox-1', byOccurrenceId: null, markedAtMs: 100 }, meta)],
    [WORK_FANOUT_INTENT_MODEL, intent],
    [WORK_FANOUT_CHECKPOINT_MODEL, newFanoutCheckpointRow({ fanoutId: String(intent.data['fanoutId']), completed: ['a'], cursor: 'admit/v2/1' }, meta)],
    [WORK_FANOUT_CHILD_MODEL, newFanoutChildRow({ fanoutId: String(intent.data['fanoutId']), parentOccurrence: 'source-1', handler: 'demo.handler', recordId: 'a' }, meta)],
    [WORK_HANDLER_OCCURRENCE_MODEL, handler.row],
  ];
}

it('publishes exactly nine frozen owning descriptors covering actual constructor and stager fields', async () => {
  const actual = await rows();
  assert.ok(Object.isFrozen(producer));
  assert.ok(Object.isFrozen(producer.models));
  assert.deepEqual(producer.models.map(item => item.model).sort(), actual.map(([model]) => model).sort());
  const exports = ['DispatchRowData', 'OccurrenceRowData', 'ScheduleRowData', 'EverySlotRowData',
    'SupersessionRowData', 'FanoutIntentRowData', 'FanoutCheckpointRowData', 'FanoutChildRowData', 'HandlerOccurrenceRowData'];
  for (const [index, [model, row]] of actual.entries()) {
    const declaration = producer.models.find(item => item.model === model)!;
    assert.deepEqual(declaration.source, { package: '@canlang/work',
      module: model === WORK_HANDLER_OCCURRENCE_MODEL ? 'kernel/handler-occurrence' : 'kernel/tables', export: exports[index] });
    assert.ok(Object.isFrozen(declaration));
    assert.ok(Object.isFrozen(declaration.source));
    assert.ok(Object.isFrozen(declaration.fields));
    const required = Object.entries(declaration.fields).filter(([, field]) => !(field.kind === 'control' && field.optional)).map(([key]) => key);
    assert.deepEqual(required.sort(), Object.keys(row.data).sort(), String(model));
    for (const field of Object.values(declaration.fields)) assert.ok(Object.isFrozen(field));
    producer.validateRow(model, row);
    producer.validateRow(model, { ...row, archivedAt: 200 });
    const legacy = { ...row }; delete legacy.parent;
    producer.validateRow(model, legacy);
    producer.validateRow(model, { ...row, parent: undefined });
    assert.equal(Object.hasOwn(legacy, 'parent'), false);
  }
  const dispatch = producer.models.find(item => item.model === WORK_DISPATCH_MODEL)!;
  assert.deepEqual(Object.entries(dispatch.fields).filter(([, field]) => field.kind === 'control' && field.optional).map(([key]) => key).sort(),
    ['requestSource', 'requestRevision', 'requestBinding', 'requestFrom', 'requestApp', 'requestOwner',
      'originalIntentId', 'observationStartedAtMs', 'observationDeadlineMs'].sort());
});

it('keeps all three payload positions opaque for benign and embedded File-like JSON', async () => {
  const actual = await rows();
  const opaque: string[] = [];
  for (const declaration of producer.models) for (const [name, field] of Object.entries(declaration.fields)) {
    if (field.kind === 'opaque') opaque.push(`${declaration.model}.${name}:${field.role}`);
    else assert.equal(field.kind, 'control');
  }
  assert.deepEqual(opaque.sort(), ['work.occurrence.result:retained-result', 'work.schedule.payload:deferred-input',
    'work.handler_occurrence.payload:deferred-input'].sort());
  for (const model of [WORK_OCCURRENCE_MODEL, WORK_SCHEDULE_MODEL, WORK_HANDLER_OCCURRENCE_MODEL]) {
    const row = actual.find(([name]) => name === model)![1];
    const key = model === WORK_OCCURRENCE_MODEL ? 'result' : 'payload';
    for (const payload of [{ benign: true }, { nested: [{ file: 'file-ref', valueType: 'File', ref: 'file-ref' }] }]) {
      producer.validateRow(model, { ...row, data: { ...row.data, [key]: payload } });
      assert.equal(producer.models.find(item => item.model === model)!.fields[key]!.kind, 'opaque');
    }
  }
});

it('refuses accessors, symbols, inherited and unknown fields without executing getters', async () => {
  const row = (await rows()).find(([model]) => model === WORK_OCCURRENCE_MODEL)![1];
  let reads = 0;
  const getter = { enumerable: true, get() { reads++; throw new Error('getter executed'); } };
  const inherited = Object.assign(Object.create({ unexpected: true }), row.data);
  const cases: StoredRow[] = [
    { ...row, data: Object.defineProperty({ ...row.data }, 'status', getter) },
    { ...row, data: Object.defineProperty({ ...row.data }, 'extra', getter) },
    { ...row, data: { ...row.data, [Symbol('extra')]: true } },
    { ...row, data: inherited },
    { ...row, data: { ...row.data, extra: true } },
    { ...row, data: { ...row.data, result: Object.defineProperty({}, 'file', getter) } },
    Object.defineProperty({ ...row }, 'data', getter),
    Object.defineProperty({ ...row }, 'parent', getter),
    Object.assign(Object.create(row), { data: row.data }),
    { ...row, [Symbol('metadata')]: true },
    { ...row, extra: true } as StoredRow,
  ];
  for (const candidate of cases) assert.throws(() => producer.validateRow(WORK_OCCURRENCE_MODEL, candidate));
  assert.equal(reads, 0);
  assert.throws(() => producer.validateRow('business.Unknown' as ModelName, row));
  let deep: unknown = null;
  for (let index = 0; index < 34; index++) deep = { next: deep };
  for (const result of [deep, Array.from({ length: 20_001 }, () => null), { nonJson: undefined }]) {
    assert.throws(() => producer.validateRow(WORK_OCCURRENCE_MODEL, { ...row, data: { ...row.data, result } }));
  }
});

it('refuses sparse or accessor control arrays and preserves owning cross-field refusals', async () => {
  const actual = await rows();
  const intent = actual.find(([model]) => model === WORK_FANOUT_INTENT_MODEL)![1];
  let reads = 0;
  const accessor: string[] = [];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { reads++; return 'a'; } });
  for (const members of [new Array<string>(2), accessor]) {
    assert.throws(() => producer.validateRow(WORK_FANOUT_INTENT_MODEL, { ...intent, data: { ...intent.data, members } }));
  }
  assert.equal(reads, 0);
  assert.throws(() => producer.validateRow(WORK_FANOUT_INTENT_MODEL, { ...intent, data: { ...intent.data, memberCount: 99 } }));
  const dispatch = actual.find(([model]) => model === WORK_DISPATCH_MODEL)![1];
  assert.throws(() => producer.validateRow(WORK_DISPATCH_MODEL, { ...dispatch, data: { ...dispatch.data, state: 'unknown' } }));
  assert.throws(() => producer.validateRow(WORK_DISPATCH_MODEL, { ...dispatch, data: { ...dispatch.data, requestSource: 'demo.source' } }));
  const handler = actual.find(([model]) => model === WORK_HANDLER_OCCURRENCE_MODEL)![1];
  assert.throws(() => producer.validateRow(WORK_HANDLER_OCCURRENCE_MODEL, { ...handler, id: 'wrong-route' as StoredRow['id'] }));
});
