/** Owning row shapes and opaque roles only; no File authority or issuer grant. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { FrameworkFilePayloadOrigin, FrameworkOpaqueCallable, FrameworkOpaqueDeclaration, FrameworkOpaqueDeclarationSet,
  FrameworkOpaqueEventInputOrigin, FrameworkOpaqueSourceRoute,
  InstalledFileReferenceInventory, ModelName, OperationId, OperationName, RecordId, RecordVersion, Revision, StoredRow } from '@canlang/contracts';
import { createSystemRegistry, systemCommandStageRevision, type SystemCommandDef } from '@canlang/state';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { newReceiptRow, RECEIPT_MODEL } from '@canlang/state/receipt/tables';
import { WORK_FILE_REFERENCE_PRODUCER as producer } from '../src/kernel/file-reference-inventory.js';
import {
  WORK_DISPATCH_MODEL, WORK_OCCURRENCE_MODEL, WORK_SCHEDULE_MODEL, WORK_EVERY_SLOT_MODEL,
  WORK_SUPERSESSION_MODEL, WORK_FANOUT_INTENT_MODEL, WORK_FANOUT_CHECKPOINT_MODEL, WORK_FANOUT_CHILD_MODEL,
  newDispatchRow, newOccurrenceRow, newScheduleRow, newEverySlotRow, newSupersessionRow,
  newFanoutIntentRow, newFanoutCheckpointRow, newFanoutChildRow,
} from '../src/kernel/tables.js';
import { WORK_HANDLER_OCCURRENCE_MODEL, stageHandlerOccurrence } from '../src/kernel/handler-occurrence.js';
import { createStandardCompletionSourceCommand } from '../src/kernel/standard-completion-source.js';
import { stageCanonicalSend } from '../src/kernel/dispatch-staging.js';

const meta = { nowMs: 100, actor: 'owner-host' };

// This owning resolver fixture provides no installed source or receiving-File authority.
function resolutionContext(binding: FrameworkFilePayloadOrigin, declarations: readonly FrameworkOpaqueDeclaration[],
  additions: Partial<FrameworkOpaqueDeclarationSet> = {}) {
  const snapshot = { owner: 'demo', snapshotId: 'original', digest: 'digest', installedRevision: 1 as Revision, installedAt: 0 };
  const set: FrameworkOpaqueDeclarationSet = { id: binding.declarationSetId, inventory: binding.inventory, snapshot,
    sources: [], canonicalModels: [], artifactModels: [], valueTypes: { contracts: [] }, originalContracts: {}, valueDefaults: [], declarations, ...additions };
  const installed = { authority: { app: 'app', stateOwner: 'team', stateStoreId: 'state', fileStoreId: 'files',
    receiver: { app: 'app', team: 'team', owner: 'files' } }, snapshot,
    inventory: { ...binding.inventory, canonicalModels: [], artifactModels: [], valueTypes: { contracts: [] },
      frameworkModels: producer.models, opaqueDeclarationSets: [set] } } as InstalledFileReferenceInventory;
  return { binding, installed };
}
function header(row: StoredRow, model: ModelName, field: 'result' | 'payload', origin: FrameworkFilePayloadOrigin['origin']): FrameworkFilePayloadOrigin {
  return { version: 1, inventory: { owner: 'demo', snapshotId: 'original', digest: 'digest' }, declarationSetId: 'original-set',
    slot: { model, id: row.id, created: row.created, createdBy: row.createdBy, field,
      role: field === 'result' ? 'retained-result' : 'deferred-input' }, scope: { app: 'app', owner: 'team', ownerPackage: 'demo' }, origin, files: [] };
}
function bound(row: StoredRow, binding: FrameworkFilePayloadOrigin): StoredRow {
  return { ...row, data: { ...row.data, filePayloadOrigin: binding } };
}

it('resolves actual staged declared and committed handler inputs and their independent terminal result recipe', async () => {
  const source = { path: 'demo.can', sha256: 'source', module: 'demo' };
  const handler: FrameworkOpaqueCallable = { source, callable: { id: 'demo.handler', kind: 'handler', module: 'demo', export: 'canApp', member: ['handler'] },
    canonical: { name: 'demo.handler' as OperationName, kind: 'scenario', inputs: [] },
    artifact: { name: 'demo.handler', kind: 'scenario', description: '', inputs: { fields: [] } }, resultDeclarationId: 'handler-return' };
  const declared = { kind: 'declared-event' as const, source, event: 'demo.Event', inputsDeclarationId: 'declared-inputs' };
  const scope = { app: 'app', owner: 'team', ownerPackage: 'demo' };
  const stage = await stageHandlerOccurrence({ source: { occurrenceId: 'source', event: 'demo.Event', payload: { file: { id: 'retained' } }, scope },
    handler: 'demo.handler' }, { actor: meta.actor, now: meta.nowMs, operation: 'source', load: async () => null, query: async () => [] });
  if (stage.status !== 'ready') throw new Error('actual handler stage refused');
  const event: FrameworkOpaqueEventInputOrigin = { kind: 'event-input', occurrenceId: stage.row.id, sourceOccurrence: 'source', declaration: declared,
    lineage: { kind: 'source', sourceOccurrence: 'source' }, target: { kind: 'handler', handler } };
  const binding = header(stage.row, WORK_HANDLER_OCCURRENCE_MODEL, 'payload', event);
  const declarations = [{ id: 'declared-inputs', source: { kind: 'event', source, event: 'demo.Event' },
    profile: { kind: 'inputs', canonical: [{ name: 'file', kind: 'file', required: true }], artifact: [{ name: 'file', field: { kind: 'file' }, required: true }] } },
    { id: 'handler-return', source: { kind: 'callable', source, callable: handler.callable },
      profile: { kind: 'void', canonical: { type: 'void' }, artifact: { type: 'void' } } }] as unknown as FrameworkOpaqueDeclaration[];
  const context = resolutionContext(binding, declarations);
  assert.deepEqual(producer.resolveOpaqueField!(WORK_HANDLER_OCCURRENCE_MODEL, bound(stage.row, binding), 'payload', context).values,
    [{ path: [], kind: 'inputs', declarationId: 'declared-inputs' }]);
  const terminal = newOccurrenceRow({ occurrenceId: stage.row.id, status: 'completed', result: null, code: null, message: null, recordedAtMs: 100 }, meta);
  const resultBinding = header(terminal, WORK_OCCURRENCE_MODEL, 'result', { kind: 'handler-result', occurrenceId: stage.row.id,
    operationId: 'handler-operation' as OperationId, handler, event });
  assert.deepEqual(producer.resolveOpaqueField!(WORK_OCCURRENCE_MODEL, bound(terminal, resultBinding), 'result',
    resolutionContext(resultBinding, declarations)).values, [{ path: [], kind: 'result', declarationId: 'handler-return', presence: 'no-result' }]);
  const badResult = { ...terminal, data: { ...terminal.data, result: { file: { id: 'not-void' } }, filePayloadOrigin: resultBinding } };
  assert.throws(() => producer.resolveOpaqueField!(WORK_OCCURRENCE_MODEL, badResult, 'result', resolutionContext(resultBinding, declarations)));
  const committedStage = await stageHandlerOccurrence({ source: { occurrenceId: 'committed-source', event: 'demo.Stored.updated',
    payload: { id: 'record', version: '2' }, scope }, handler: 'demo.handler' },
  { actor: meta.actor, now: meta.nowMs, operation: 'source', load: async () => null, query: async () => [] });
  if (committedStage.status !== 'ready') throw new Error('actual committed route stage refused');
  const committed: FrameworkOpaqueEventInputOrigin = { kind: 'event-input', occurrenceId: committedStage.row.id, sourceOccurrence: 'committed-source',
    declaration: { kind: 'committed-change', source, descriptor: { source: 'demo.Stored.updated', model: 'demo.Stored', change: 'update', handlers: ['demo.handler'] },
      change: { recordId: 'record' as RecordId, owner: 'team', version: 2 as RecordVersion, occurrenceId: 'committed-source' }, projectionInputsDeclarationId: 'projection-inputs' },
    lineage: { kind: 'source', sourceOccurrence: 'committed-source' }, target: { kind: 'handler', handler } };
  const committedBinding = header(committedStage.row, WORK_HANDLER_OCCURRENCE_MODEL, 'payload', committed);
  const projection = { id: 'projection-inputs', source: { kind: 'callable', source, callable: handler.callable }, profile: { kind: 'inputs',
    canonical: [{ name: 'id', kind: 'string', valueType: 'text', required: true }, { name: 'version', kind: 'integer', valueType: 'int', required: true }],
    artifact: [{ name: 'id', field: { kind: 'string' }, valueType: 'text', required: true }, { name: 'version', field: { kind: 'integer' }, valueType: 'int', required: true }] } } as unknown as FrameworkOpaqueDeclaration;
  const committedContext = resolutionContext(committedBinding, [projection]);
  assert.deepEqual(producer.resolveOpaqueField!(WORK_HANDLER_OCCURRENCE_MODEL, bound(committedStage.row, committedBinding), 'payload', committedContext).values,
    [{ path: [], kind: 'inputs', declarationId: 'projection-inputs' }]);
  assert.throws(() => producer.resolveOpaqueField!(WORK_HANDLER_OCCURRENCE_MODEL,
    { ...bound(committedStage.row, committedBinding), data: { ...committedStage.row.data, filePayloadOrigin: committedBinding,
      payload: { recordId: 'record', owner: 'team', version: 2, occurrenceId: 'committed-source' } } }, 'payload', committedContext));
  const copy = { ...binding, slot: { ...binding.slot, model: WORK_SCHEDULE_MODEL } };
  assert.throws(() => producer.resolveOpaqueField!(WORK_HANDLER_OCCURRENCE_MODEL, bound(stage.row, copy), 'payload', context));
  assert.throws(() => producer.resolveOpaqueField!(WORK_HANDLER_OCCURRENCE_MODEL, stage.row, 'payload', context));
  assert.throws(() => producer.resolveOpaqueField!(WORK_HANDLER_OCCURRENCE_MODEL, bound(stage.row, binding), 'filePayloadOrigin', context));
});

it('checks complete scheduled routing summaries and committed control envelopes without inventing typed payloads', () => {
  const source = { path: 'demo.can', sha256: 'source', module: 'demo' };
  const handler = (id: string): FrameworkOpaqueCallable => ({ source, callable: { id, kind: 'handler', module: 'demo', export: 'canApp', member: [id] },
    canonical: { name: id as OperationName, kind: 'scenario', inputs: [] }, artifact: { name: id, kind: 'scenario', description: '', inputs: { fields: [] } }, resultDeclarationId: `${id}/void` });
  const ordinary = handler('demo.ordinary'), fanout = handler('demo.fanout');
  const intent = newFanoutIntentRow({ sourceOccurrence: 'schedule-source', handler: 'demo.fanout', cohort: 'model', members: ['a', 'b'] }, meta);
  const routes: FrameworkOpaqueSourceRoute[] = [{ kind: 'ordinary', handler: ordinary, occurrenceId: 'handler/v1/schedule-source/demo.ordinary' },
    { kind: 'fanout', handler: fanout, cohort: { kind: 'model', owner: 'team', model: 'demo.Stored' }, fanoutId: intent.id,
      members: ['a', 'b'], memberCount: 2, firstChunkCount: 1, cursor: 'admit/v2/1' }];
  const event: FrameworkOpaqueEventInputOrigin = { kind: 'event-input', occurrenceId: 'schedule-source', sourceOccurrence: 'schedule-source',
    declaration: { kind: 'declared-event', source, event: 'demo.Event', inputsDeclarationId: 'event-inputs' },
    lineage: { kind: 'schedule', key: 'key', replaces: null }, target: { kind: 'schedule' } };
  const result = { fanouts: [{ handler: 'demo.fanout', fanoutId: intent.id }], bounds: { pageLimit: 2, chunkSize: 1 },
    handlers: [{ handler: 'demo.ordinary', occurrenceId: 'handler/v1/schedule-source/demo.ordinary' }] };
  const row = newOccurrenceRow({ occurrenceId: 'schedule-source', status: 'completed', result, code: null, message: null, recordedAtMs: 100 }, meta);
  const binding = header(row, WORK_OCCURRENCE_MODEL, 'result', { kind: 'source-routing', occurrenceId: row.id, revision: 1 as Revision,
    recipe: { kind: 'scheduled-routes', event, bounds: result.bounds, routes } });
  const context = resolutionContext(binding, []), candidate = bound(row, binding);
  assert.deepEqual(producer.resolveOpaqueField!(WORK_OCCURRENCE_MODEL, candidate, 'result', context).values, []);
  const bad = structuredClone(candidate);
  (bad.data['result'] as typeof result).handlers[0]!.occurrenceId = 'foreign';
  assert.throws(() => producer.resolveOpaqueField!(WORK_OCCURRENCE_MODEL, bad, 'result', context));
  const cohortOnly = newOccurrenceRow({ ...row.data, occurrenceId: row.id, status: 'completed', result: { fanouts: result.fanouts,
    bounds: result.bounds }, code: null, message: null, recordedAtMs: 100 }, meta);
  const cohortBinding = header(cohortOnly, WORK_OCCURRENCE_MODEL, 'result', { kind: 'source-routing', occurrenceId: row.id, revision: 1 as Revision,
    recipe: { kind: 'scheduled-cohorts', event, bounds: result.bounds,
      routes: routes.filter((route): route is Extract<FrameworkOpaqueSourceRoute, { kind: 'fanout' }> => route.kind === 'fanout') } });
  assert.deepEqual(producer.resolveOpaqueField!(WORK_OCCURRENCE_MODEL, bound(cohortOnly, cohortBinding), 'result', resolutionContext(cohortBinding, [])).values, []);
  const scope = { app: 'app', owner: 'team', ownerPackage: 'demo' }, bounds = { maxSources: 2, maxHandlers: 2, maxMembers: 2, chunkSize: 1 };
  const change = { model: 'demo.Stored' as ModelName, recordId: 'record' as RecordId, version: 2 as RecordVersion, kind: 'updated' as const };
  const payload = { recordId: 'record' as RecordId, owner: 'team', version: 2 as RecordVersion, occurrenceId: 'committed-source' };
  const attribution = { kind: 'user' as const, app: 'app', actor: { userId: 'user' }, team: { teamId: 'team', timezone: 'UTC' },
    operation: 'demo.update' as OperationName, operationId: 'update-operation' as OperationId, source: 'browser', now: 100 };
  const route: FrameworkOpaqueSourceRoute = { kind: 'ordinary', handler: ordinary, occurrenceId: 'handler/v1/committed-source/demo.ordinary' };
  const committedResult = { kind: 'committed-model-source', change, event: 'demo.Stored.updated', payload, context: attribution,
    revision: 1, scope, bounds, handlers: [{ kind: 'ordinary', handler: 'demo.ordinary', occurrenceId: route.occurrenceId }] };
  const committed = newOccurrenceRow({ occurrenceId: 'committed-source', status: 'completed', result: committedResult, code: null, message: null, recordedAtMs: 100 }, meta);
  const committedBinding = header(committed, WORK_OCCURRENCE_MODEL, 'result', { kind: 'source-routing', occurrenceId: committed.id, revision: 1 as Revision,
    recipe: { kind: 'committed-model', source, descriptor: { source: 'demo.Stored.updated', model: 'demo.Stored', change: 'update', handlers: ['demo.ordinary'] },
      change, payload, context: attribution, bounds, routes: [route] } });
  const committedContext = resolutionContext(committedBinding, []);
  assert.deepEqual(producer.resolveOpaqueField!(WORK_OCCURRENCE_MODEL, bound(committed, committedBinding), 'result', committedContext).values, []);
  const rawExtra = { ...committed, data: { ...committed.data, filePayloadOrigin: committedBinding,
    result: { ...committedResult, payload: { ...payload, file: { id: 'hidden' } } } } };
  assert.throws(() => producer.resolveOpaqueField!(WORK_OCCURRENCE_MODEL, rawExtra, 'result', committedContext));
});
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
    const required = Object.entries(declaration.fields).filter(([, field]) => !(field.kind === 'control' && field.optional ||
      field.kind === 'opaque' && (field.role === 'payload-origin' || field.role === 'deferred-input') && field.optional)).map(([key]) => key);
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
  assert.deepEqual(opaque.sort(), ['work.dispatch.sourceGuard:deferred-input', 'work.dispatch.filePayloadOrigin:payload-origin', 'work.occurrence.result:retained-result', 'work.schedule.payload:deferred-input',
    'work.handler_occurrence.payload:deferred-input', 'work.occurrence.filePayloadOrigin:payload-origin',
    'work.schedule.filePayloadOrigin:payload-origin', 'work.handler_occurrence.filePayloadOrigin:payload-origin'].sort());
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

it('resolves the actual standard completion writer, including retained provider inputs, duplicate result and typed schema defaults', async () => {
  const store = createMemoryStorage(), provider = 'std.ExampleV1.send', completion = 'demo.Provider.completed';
  const source = { path: 'demo.can', sha256: 'original-source', module: 'demo' };
  const result = { name: 'Run', fields: [{ name: 'file', type: 'file' }] };
  const delivery = { kind: 'capability' as const, canonical: { kind: 'delivery' as const, capability: 'std.ExampleV1',
    operation: 'send', version: 1, result }, artifact: { kind: 'delivery' as const, capability: 'std.ExampleV1', operation: 'send', version: 1, result } };
  const providerInput = { name: 'file', field: { kind: 'file' }, required: false,
    default: { kind: 'literal', value: { id: 'provider-default' } } };
  const status = ['succeeded', 'failed', 'unknown', 'skipped'];
  const eventFields = [
    { name: 'delivery_id', field: { kind: 'string' }, valueType: 'text', required: true },
    { name: 'status', field: { kind: 'enum', values: status }, required: true },
    { name: 'result', field: { kind: 'nominal', name: 'Run' }, valueType: 'Run?', nullable: true, required: false },
    { name: 'error', field: { kind: 'nominal', name: 'Error' }, valueType: 'Error?', nullable: true, required: false },
  ];
  const declarations = [
    { id: 'provider-inputs', source: { kind: 'delivery', source, context: delivery }, profile: { kind: 'inputs',
      canonical: [{ name: 'file', kind: 'file', required: false, default: providerInput.default }], artifact: [providerInput] } },
    { id: 'event-inputs', source: { kind: 'event', source, event: completion }, profile: { kind: 'inputs',
      canonical: eventFields.map(field => ({ name: field.name, kind: field.field.kind === 'nominal' ? 'nominal' :
        field.field.kind === 'string' ? 'string' : 'enum', required: field.required,
        ...(field.valueType === undefined ? {} : { valueType: field.valueType }) })), artifact: eventFields } },
    { id: 'provider-result', source: { kind: 'delivery', source, context: delivery },
      profile: { kind: 'provider-result', canonical: result, artifact: result } },
  ] as unknown as FrameworkOpaqueDeclaration[];
  const schema = { contracts: {
    Run: { fields: { file: { type: 'file' } } }, Error: { fields: { code: { type: 'text' }, message: { type: 'text' } } },
    CapturedDefaults: { fields: { file: { type: 'file', default: { id: 'value-default' } },
      absent: { type: 'file?', default: null }, disabled: { type: 'bool', default: false },
      empty: { type: 'text', default: '' }, files: { type: 'file[]', default: [] } } },
    'demo.Stored': { fields: { file: { type: 'file', default: { id: 'model-default' } } } },
  }, operations: {
    [provider]: { inputs: { file: { type: 'file', default: { id: 'provider-default' } } } },
    [completion]: { inputs: { delivery_id: { type: 'text' }, status: { type: 'enum(succeeded,failed,unknown,skipped)' },
      result: { type: 'Run?' }, error: { type: 'Error?' } } },
  } };
  const bounds = { maxSources: 2, maxHandlers: 2, maxMembers: 2, chunkSize: 2 };
  const issuer = createStandardCompletionSourceCommand({ scope: { app: 'app', owner: 'team', ownerPackage: 'demo' },
    schema, modelNames: ['demo.Stored'], declarations: [{ source: provider, event: completion,
      binding: 'demo.Provider', from: 'host.provider', resultType: 'Run', handlers: [] }], bounds });
  const originOperationId = 'original-operation';
  const send: SystemCommandDef = { name: 'fixture.send', stage: async (_args, ctx) => {
    const staged = await stageCanonicalSend({ operationId: originOperationId, source: provider, occurrenceIndex: 0,
      request: { binding: 'demo.Provider', from: 'host.provider', arguments: { file: { id: 'actual-provider-input' } } }, originOccurrence: null }, ctx);
    return { ...staged.effects, result: { deliveryId: staged.delivery.id } };
  } };
  const settle: SystemCommandDef = { name: 'fixture.settle', stage: (args, ctx) => ({ writes: [{ kind: 'insert',
    model: RECEIPT_MODEL as ModelName, row: newReceiptRow({ deliveryId: String(args.deliveryId),
      revision: systemCommandStageRevision(ctx), status: 'succeeded', result: { file: { id: 'actual-result' } },
      error: null, contentRef: null, resultExpiresAtMs: null }, { nowMs: ctx.now, actor: ctx.actor }) }] }) };
  const registry = createSystemRegistry([send, settle, issuer]);
  const run = (name: string, args: Record<string, unknown>, id: string) => registry.run(name, args,
    { actor: 'owner-host', now: Date.now(), operation: 'demo.request', operationId: id }, { store });
  const sent = await run(send.name, {}, originOperationId);
  const deliveryId = (sent.result as { deliveryId: string }).deliveryId;
  const retained = await store.outboxGet(deliveryId);
  const dispatch = await store.load(WORK_DISPATCH_MODEL, deliveryId as RecordId);
  assert.ok(retained?.originalCommit);
  assert.ok(dispatch);
  assert.equal(retained.intent.operationId, originOperationId);
  assert.ok(dispatch.created <= retained.originalCommit.createdAt);
  await run(settle.name, { deliveryId }, 'settle-run');
  await run(issuer.name, { deliveryId }, 'source-run');
  const row = await store.load(WORK_OCCURRENCE_MODEL, `standard-completion/v1/${encodeURIComponent(deliveryId)}` as RecordId);
  assert.ok(row);
  const physical = row.data['result'] as Record<string, any>;
  const original = physical.origin;
  const binding = header(row, WORK_OCCURRENCE_MODEL, 'result', {
    kind: 'standard-completion', occurrenceId: row.id,
    declaration: { kind: 'standard-completion', source, event: completion, providerSource: provider,
      binding: 'demo.Provider', from: 'host.provider', sourceInputsDeclarationId: 'provider-inputs',
      inputsDeclarationId: 'event-inputs', resultDeclarationId: 'provider-result', delivery },
    originalIntent: { intentId: original.intent.intentId, operation: original.intent.operation,
      operationId: original.intent.operationId, target: original.intent.target, occurrenceIndex: original.intent.occurrenceIndex },
    originalCommit: original.originalCommit, dispatch: { kind: 'capability', ...original.dispatch },
    terminal: { revision: physical.terminal.revision, status: physical.terminal.status, error: physical.terminal.error },
    revision: physical.revision, bounds, routes: [],
  } as FrameworkFilePayloadOrigin['origin']);
  const model = { name: 'demo.Stored' as ModelName, fields: { file: { required: false, serverOnly: false,
    default: { kind: 'literal', value: { id: 'model-default' } } } }, deleteMode: 'archive' };
  const modelArtifact = { name: 'demo.Stored', fields: [{ name: 'file', field: { kind: 'file' }, required: false,
    serverOnly: false, default: { kind: 'literal', value: { id: 'model-default' } } }], deleteMode: 'archive' };
  const capturedDefaults = Object.entries(schema.contracts.CapturedDefaults.fields).map(([field, original]) => ({
    contract: 'CapturedDefaults', field, value: original.default,
  }));
  const context = resolutionContext(binding, declarations, { canonicalModels: [model], artifactModels: [modelArtifact],
    valueTypes: { contracts: [result, { name: 'Error', fields: [{ name: 'code', type: 'text' }, { name: 'message', type: 'text' }] },
      { name: 'CapturedDefaults', fields: Object.entries(schema.contracts.CapturedDefaults.fields).map(([name, original]) => ({ name, type: original.type })) }] },
    valueDefaults: capturedDefaults } as Partial<FrameworkOpaqueDeclarationSet>);
  const candidate = bound(row, binding), resolved = producer.resolveOpaqueField!(WORK_OCCURRENCE_MODEL, candidate, 'result', context);
  assert.deepEqual(resolved.values.map(value => value.path), [
    ['origin', 'intent', 'arguments', 'arguments'], ['definition', 'schema', 'operations', provider, 'inputs', 'file', 'default'],
    ...capturedDefaults.map(entry => ['definition', 'schema', 'contracts', 'CapturedDefaults', 'fields', entry.field, 'default']),
    ['definition', 'schema', 'contracts', 'demo.Stored', 'fields', 'file', 'default'], ['terminal', 'result'], ['payload'],
  ]);
  assert.deepEqual(resolved.values.flatMap(value => value.kind === 'default' && value.owner.kind === 'value-field' ? [value.owner] : []),
    capturedDefaults.map(entry => ({ kind: 'value-field', contract: entry.contract, field: entry.field })));
  assert.deepEqual(capturedDefaults.map(entry => entry.value), [{ id: 'value-default' }, null, false, '', []]);
  assert.ok(Object.isFrozen(resolved.values));
  assert.deepEqual(resolved.binding, binding);
  for (const mutate of [
    (value: Record<string, any>) => { value.terminal.result.file.id = 'changed-duplicate'; },
    (value: Record<string, any>) => { value.origin.intent.arguments.extra = true; },
    (value: Record<string, any>) => { value.definition.schema.operations[provider].inputs.file.default.id = 'changed-default'; },
    (value: Record<string, any>) => { value.definition.schema.contracts.Run.fields.file.type = 'text'; },
    (value: Record<string, any>) => { delete value.definition.schema.contracts.CapturedDefaults.fields.absent.default; },
    (value: Record<string, any>) => { value.definition.schema.contracts.CapturedDefaults.fields.disabled.default = true; },
    (value: Record<string, any>) => { value.definition.modelNames = []; },
    (value: Record<string, any>) => { value.handlers = [{ kind: 'ordinary', handler: 'foreign', occurrenceId: 'copy' }]; },
    (value: Record<string, any>) => { value.extra = { file: { id: 'hidden' } }; },
  ]) {
    const changed = structuredClone(candidate);
    mutate(changed.data['result'] as Record<string, any>);
    assert.throws(() => producer.resolveOpaqueField!(WORK_OCCURRENCE_MODEL, changed, 'result', context));
  }
  for (const mutate of [
    (set: Record<string, any>) => { delete set.valueDefaults; },
    (set: Record<string, any>) => { set.valueDefaults = []; },
    (set: Record<string, any>) => { set.valueDefaults.push(set.valueDefaults[0]); },
    (set: Record<string, any>) => { set.valueDefaults.push({ contract: 'CapturedDefaults', field: 'unknown', value: null }); },
    (set: Record<string, any>) => { set.valueDefaults.push({ contract: 'Error', field: 'code', value: '' }); },
    (set: Record<string, any>) => { set.valueDefaults.find((entry: Record<string, any>) => entry.field === 'absent').value = ''; },
    (set: Record<string, any>) => { set.valueDefaults.find((entry: Record<string, any>) => entry.field === 'disabled').value = true; },
  ]) {
    const changed = structuredClone(context);
    mutate(changed.installed.inventory.opaqueDeclarationSets![0]! as unknown as Record<string, any>);
    assert.throws(() => producer.resolveOpaqueField!(WORK_OCCURRENCE_MODEL, candidate, 'result', changed));
  }
  let reads = 0;
  const getter = Object.defineProperty(structuredClone(candidate.data['result']), 'terminal', { enumerable: true,
    get() { reads++; throw new Error('must not execute'); } });
  assert.throws(() => producer.resolveOpaqueField!(WORK_OCCURRENCE_MODEL, { ...candidate, data: { ...candidate.data, result: getter } }, 'result', context));
  assert.equal(reads, 0);
});
