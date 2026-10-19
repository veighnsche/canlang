/** Real local D1 producer/reader/viewer join; no native app or process restart claim. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { GenerationCallbackOrigin, ModelName, StoragePort } from '@canlang/contracts';
import type { SystemCommandContext, SystemStaging } from '@canlang/state';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { StateError } from '@canlang/state/errors';
import { runMutationWrites, type MutationWrite } from '@canlang/state/mutation/pipeline';
import { buildModelTable } from '@canlang/state/mutation/models';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '@canlang/state/invocation/registry';
import { queryGenerationCallbackDiagnosticsForViewer, newAssociationRow, newReceiptRow,
  RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL } from '@canlang/state/receipt';
import { grant, modelPolicy, policyTable } from '@canlang/state/testing/query/fixtures';
import { field, modelDef, pipelineContext } from '@canlang/state/testing/mutation/fixtures';
import { asId, asModel, makeBatch, makeReceipt, FIXED_NOW } from '@canlang/state/testing/invocation/fixtures';
import { readGenerationCallbackDiagnostics } from '../../src/kernel/callback-diagnostics.js';
import { workDispatchStageCommand } from '../../src/kernel/dispatch-staging.js';
import { workSchedulePutCommand, stageDueSchedule } from '../../src/kernel/schedule-staging.js';
import { stageHandlerOccurrence, stageHandlerOccurrenceTerminal, handlerOccurrenceRowId,
  WORK_HANDLER_OCCURRENCE_MODEL } from '../../src/kernel/handler-occurrence.js';
import { workOccurrencePutReceiptCommand } from '../../src/kernel/occurrence-staging.js';
import { WORK_DISPATCH_MODEL, WORK_OCCURRENCE_MODEL, WORK_SCHEDULE_MODEL } from '../../src/kernel/tables.js';

const MODEL = asModel('CanCreative.Book'), PARENT = asModel('CanCreative.Shelf'), ID = asId('book');
const DELIVERY = 'original-delivery', NOTICE = 'notice/1', HANDLER = 'CanCreative.Book.onProgress';
const scope = { app: 'creative-app', owner: 'team', ownerPackage: 'CanCreative' };
const origin: GenerationCallbackOrigin = Object.freeze({ source: 'std.ImagesV1.submit', sourceRevision: '1',
  binding: 'CanCreative.Images', from: 'local-images', scope: Object.freeze({ ...scope }),
  event: 'CanCreative.Images.submit.progressed', handlers: Object.freeze([HANDLER]) });

test('genuine D1 callback refusal survives adapter reopen and is disclosed only under current State authority', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(db);
    let store = createD1Storage(db);
    const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
    const caller = await memberships.createMembership({ team_id: scope.owner, user_id: 'caller', is_owner: false, roles: [] });
    const table = buildModelTable([
      modelDef(MODEL, { fields: { request: field(), title: field() }, deleteMode: 'remove' }),
      modelDef(PARENT, { fields: { title: field() }, deleteMode: 'remove' }),
    ]);
    async function business(writes: readonly MutationWrite[]) {
      const revision = await store.readRevision();
      const effects = await runMutationWrites({ table, store, writes,
        context: pipelineContext({ operation: 'CanCreative.change', actor: 'caller', teamId: scope.owner }) });
      await store.commit(makeBatch(revision, effects));
    }
    await business([
      { op: 'create', model: PARENT, id: asId('shelf'), data: { title: 'Shelf' } },
      { op: 'create', model: MODEL, id: ID, parent: { model: PARENT, id: asId('shelf') },
        data: { title: 'Book', request: { id: DELIVERY, operation: origin.source } } },
    ]);
    const context = (): SystemCommandContext => ({ actor: 'owner-host', now: 100, operation: 'CanCreative.generate',
      load: (model, id) => store.load(model, id), query: spec => store.query(spec) });
    const commit = async (effects: SystemStaging) => store.commit(makeBatch(await store.readRevision(), effects));
    const dispatch = await workDispatchStageCommand.stage({ operationId: 'original-operation', intents: [{
      intentId: DELIVERY, operation: 'CanCreative.generate', originOperationId: 'original-operation', source: origin.source,
      occurrenceIndex: 0, originOccurrence: null, guard: null, guardVerdict: null,
      request: { binding: origin.binding, from: origin.from, arguments: { value: { source: 'request-source', revision: '1' } } },
      correlation: { requestSource: 'request-source', requestRevision: '1', requestBinding: origin.binding,
        requestFrom: origin.from, requestApp: scope.app, requestOwner: scope.owner },
    }] }, context());
    const dispatchRevision = await store.readRevision();
    const invocationReceipt = makeReceipt({ app: scope.app, owner: scope.owner, operation: 'CanCreative.generate',
      operationId: 'original-operation', createdAt: 100, committedRevision: dispatchRevision + 1 });
    await store.commit(makeBatch(dispatchRevision, { ...dispatch, receipt: invocationReceipt }));
    const generationRevision = await store.readRevision();
    await store.commit(makeBatch(generationRevision, { writes: [
      { kind: 'insert', model: RECEIPT_ASSOCIATION_MODEL as ModelName,
        row: newAssociationRow({ recordModel: MODEL, recordId: ID, field: 'request', deliveryId: DELIVERY,
          source: origin.source, revision: generationRevision }, { nowMs: 100, actor: 'owner-host' }) },
      { kind: 'insert', model: RECEIPT_MODEL as ModelName,
        row: newReceiptRow({ deliveryId: DELIVERY, revision: generationRevision, status: 'pending', result: null,
          error: null, contentRef: null, resultExpiresAtMs: null }, { nowMs: 100, actor: 'owner-host' }) },
    ] }));
    const schedule = { key: NOTICE, occurrenceId: NOTICE, scope, at: 100, event: origin.event,
      payload: { delivery_id: DELIVERY } };
    await commit(await workSchedulePutCommand.stage(schedule, context()));
    const due = await stageDueSchedule(schedule, context()); assert.equal(due.status, 'ready');
    if (due.status !== 'ready') throw new Error('Expected genuine due schedule');
    const route = await stageHandlerOccurrence({ source: { occurrenceId: NOTICE, event: origin.event,
      payload: { delivery_id: DELIVERY }, scope }, handler: HANDLER }, context());
    assert.equal(route.status, 'ready');
    if (route.status !== 'ready') throw new Error('Expected genuine handler route');
    const sourceReceipt = await workOccurrencePutReceiptCommand.stage({ occurrenceId: NOTICE, status: 'completed',
      result: { fanouts: [], bounds: { pageLimit: 100, chunkSize: 100 },
        handlers: [{ handler: HANDLER, occurrenceId: route.occurrence.occurrenceId }] } }, context());
    await commit({ writes: [...due.effects.writes ?? [], ...route.effects.writes ?? [], ...sourceReceipt.writes ?? []],
      schedules: due.effects.schedules ?? [] });
    const terminal = await stageHandlerOccurrenceTerminal({ sourceOccurrence: NOTICE, handler: HANDLER,
      event: origin.event, scope, expectedVersion: 1, receipt: { status: 'failed', result: null, code: 'require-false',
        message: 'handler requirement rejected the occurrence', recordedAtMs: 100 } }, context());
    assert.equal(terminal.status, 'ready');
    if (terminal.status !== 'ready') throw new Error('Expected genuine failed terminal');
    await commit(terminal.effects);

    const schema = loadArtifactDescriptors({ artifact_version: 1, operations: [], models: [{ name: MODEL,
      deleteMode: 'remove', fields: [{ name: 'request', required: false, serverOnly: false, field: {
        kind: 'delivery', capability: 'std.ImagesV1', operation: 'submit', version: 1,
        result: { name: 'ImagesSubmit', fields: [] },
      } }] }] } as ArtifactDescriptorSlice, { by: 'members' }).deliveryFields;
    const policy = policyTable(modelPolicy(MODEL, { grants: [grant('members', ['request.id']),
      grant('owner', ['request.result', 'request.error'])] }), modelPolicy(PARENT, { grants: [grant('members', ['title'])] }));
    const callbackPolicy = policyTable(modelPolicy(MODEL, { grants: [grant('members', [])] })).get(MODEL)!;
    const input = () => ({ model: MODEL, recordId: ID, field: 'request', schema, policy, callbackPolicy, origin,
      store, memberships, context: { actorUserId: 'caller', teamId: scope.owner },
      readPolicies: new Map([[MODEL, { by: 'members' as const, parent: PARENT }], [PARENT, { by: 'members' as const }]]),
      readDiagnostics: readGenerationCallbackDiagnostics });
    const models = [MODEL, PARENT, RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL, WORK_DISPATCH_MODEL,
      WORK_SCHEDULE_MODEL, WORK_OCCURRENCE_MODEL, WORK_HANDLER_OCCURRENCE_MODEL] as unknown as readonly ModelName[];
    const snapshot = async () => ({ revision: await store.readRevision(),
      rows: await Promise.all(models.map(model => store.query({ model, authority: 'owner' }))),
      outbox: await store.outboxGet(DELIVERY), receipt: await store.readReceipt(invocationReceipt.identity) });
    const before = await snapshot(), expectedDiagnostic = { outcome: 'complete', snapshotAttribution: 'unsupported',
      failures: [{ deliveryId: DELIVERY, sourceOccurrence: NOTICE, occurrenceId: handlerOccurrenceRowId(NOTICE, HANDLER),
        handler: HANDLER, event: origin.event, recordedAtMs: 100, code: 'require-false',
        message: 'handler requirement rejected the occurrence' }] };
    const observed = await queryGenerationCallbackDiagnosticsForViewer(input());
    assert.deepEqual(observed, { outcome: 'observed', revision: before.revision, origin, diagnostic: expectedDiagnostic });
    assert.ok(Object.isFrozen(observed));
    if (observed.outcome === 'observed' && observed.diagnostic.outcome === 'complete') {
      assert.ok(Object.isFrozen(observed.diagnostic.failures[0]));
    }
    assert.deepEqual(await snapshot(), before);
    store = createD1Storage(db);
    assert.deepEqual(await queryGenerationCallbackDiagnosticsForViewer(input()), observed);
    assert.deepEqual(await snapshot(), before);
    const provider = await store.load(RECEIPT_MODEL as ModelName, asId(DELIVERY)); assert.ok(provider);
    assert.equal(provider.data.status, 'pending'); assert.equal(provider.data.error, null);

    assert.deepEqual(await queryGenerationCallbackDiagnosticsForViewer({ ...input(), origin: {
      ...origin, scope: { ...origin.scope, owner: 'foreign' },
    } }), { outcome: 'withheld' });
    const mismatch = await queryGenerationCallbackDiagnosticsForViewer({ ...input(), origin: { ...origin, from: 'other-binding' } });
    assert.deepEqual(mismatch, { outcome: 'observed', revision: before.revision, origin: { ...origin, from: 'other-binding' },
      diagnostic: { outcome: 'unsupported', reason: 'origin-correspondence' } });
    const missingHandlers = await queryGenerationCallbackDiagnosticsForViewer({ ...input(), origin: { ...origin, handlers: [] } });
    assert.deepEqual(missingHandlers, { outcome: 'observed', revision: before.revision, origin: { ...origin, handlers: [] },
      diagnostic: { outcome: 'unsupported', reason: 'origin-correspondence' } });
    assert.deepEqual(await snapshot(), before);
    await business([{ op: 'update', model: MODEL, id: ID,
      data: { request: { id: 'replacement-delivery', operation: origin.source } } }]);
    await assert.rejects(queryGenerationCallbackDiagnosticsForViewer(input()),
      error => error instanceof StateError && error.code === 'validation');
    await business([{ op: 'update', model: MODEL, id: ID,
      data: { request: { id: DELIVERY, operation: origin.source } } }]);
    const revokeInput = input();
    revokeInput.readDiagnostics = async (request, actualStore: StoragePort) => {
      const result = await readGenerationCallbackDiagnostics(request, actualStore);
      await memberships.removeMembership(caller.membership_id);
      return result;
    };
    await assert.rejects(queryGenerationCallbackDiagnosticsForViewer(revokeInput),
      error => error instanceof StateError && error.code === 'forbidden');
    assert.deepEqual(await queryGenerationCallbackDiagnosticsForViewer(input()), { outcome: 'withheld' });
    assert.deepEqual(await store.load(RECEIPT_MODEL as ModelName, asId(DELIVERY)), provider);
    assert.deepEqual(await store.outboxGet(DELIVERY), before.outbox);
    assert.deepEqual(await store.readReceipt(invocationReceipt.identity), before.receipt);
  } finally { await mf.dispose(); }
});
