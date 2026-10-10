/** Defining portable Work source issuance from genuinely retained send,
 * dispatch and receipt facts. Installed declarations here do not qualify
 * Compiler projection, native enrollment, provider provenance or deployment. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelName, ReceiptStatus, StoragePort, StoredRow, WorkScope } from '@canlang/contracts';
import { DELIVERY_RESULT_LEAVES } from '@canlang/contracts';
import { createSystemRegistry, StateError, systemCommandStageRevision,
  type SystemCommandContext, type SystemCommandDef, type SystemStaging } from '@canlang/state';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { RECEIPT_MODEL, ReceiptTableError, newReceiptRow } from '@canlang/state/receipt/tables';
import { FIXED_NOW, asId, asModel, asVersion, createMemoryIdentityStore, makeBatch, seedMember,
  makeRow, seedRow } from '@canlang/state/testing/invocation/fixtures';
import type { FanoutCohortSpec } from '@canlang/state/fanout/cohort';
import { SchemaError, ValueError, type SchemaDescriptor } from '@canlang/values';
import { createStandardCompletionSourceCommand } from '../src/kernel/standard-completion-source.js';
import { stageCanonicalSend } from '../src/kernel/dispatch-staging.js';
import { workDispatchClaimCommand, workDispatchRecordAttemptCommand } from '../src/kernel/commands.js';
import { WORK_DISPATCH_MODEL, WORK_OCCURRENCE_MODEL, WORK_FANOUT_INTENT_MODEL,
  WORK_FANOUT_CHECKPOINT_MODEL, WORK_FANOUT_CHILD_MODEL, KernelTableError,
  fanoutIntentRowId, fanoutCheckpointRowId, fanoutChildRowId, newOccurrenceRow, readOccurrenceRow,
  readFanoutIntentRow, readFanoutCheckpointRow, readFanoutChildRow, readDispatchRow } from '../src/kernel/tables.js';
import { WORK_HANDLER_OCCURRENCE_MODEL, handlerOccurrenceRowId,
  readHandlerOccurrenceRow, stageHandlerOccurrence } from '../src/kernel/handler-occurrence.js';

const SOURCE = 'std.TextGenerationV1.cancel', EVENT = 'Demo.LLM.cancel.completed';
const BINDING = 'Demo.LLM', FROM = 'deployment.llm';
const ITEM = asModel('Demo.Item'), PARENT = asModel('Demo.Parent'), EMPTY = asModel('Demo.Empty');
const bounds = { maxSources: 4, maxHandlers: 8, maxMembers: 4, chunkSize: 2 };
const framework = [WORK_OCCURRENCE_MODEL, WORK_HANDLER_OCCURRENCE_MODEL, WORK_FANOUT_INTENT_MODEL,
  WORK_FANOUT_CHECKPOINT_MODEL, WORK_FANOUT_CHILD_MODEL];
type Route = { handler: string; cohort?: FanoutCohortSpec };
let sequence = 0;
function declarations(): SchemaDescriptor {
  return { contracts: {
    TextRun: { fields: Object.fromEntries(DELIVERY_RESULT_LEAVES['TextRun']!.map(leaf => [leaf.name, { type: leaf.type }])) },
    DeliveryError: { fields: { code: { type: 'text' }, message: { type: 'text' } } },
  }, operations: {
    [SOURCE]: { inputs: { source: { type: 'text' }, revision: { type: 'int' } } },
    [EVENT]: { inputs: { delivery_id: { type: 'text' },
      status: { type: 'enum(succeeded,failed,unknown,skipped)' },
      result: { type: 'TextRun?' }, error: { type: 'DeliveryError?' } } },
  } };
}
const resultValue = () => ({ source: 'Demo.job', revision: '7', sequence: '2', state: 'cancelled',
  content: '', used_tokens: null, detail: null });
const refusal = (error: unknown) => error instanceof KernelTableError || error instanceof StateError ||
  error instanceof ReceiptTableError || error instanceof SchemaError || error instanceof ValueError;
async function rows(store: StoragePort, model: string) {
  return store.query({ model: asModel(model), authority: 'owner', archived: 'include', order: [{ field: 'id', direction: 'asc' }] });
}
async function sourceRows(store: StoragePort) {
  return Promise.all(framework.map(async model => [model, await rows(store, model)]));
}
interface Options {
  routes?: (scope: WorkScope) => Route[];
  bounds?: typeof bounds;
  binding?: string;
  from?: string;
  arguments?: Record<string, unknown>;
  correlation?: boolean;
  schema?: SchemaDescriptor;
}
async function world(options: Options = {}) {
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const scope: WorkScope = { app: 'demo-app', owner: member.team.team_id, ownerPackage: 'Demo' };
  const handlers = options.routes?.(scope) ?? [{ handler: 'Demo.completed' }, { handler: 'Demo.sibling' }];
  const installed = () => createStandardCompletionSourceCommand({ scope, schema: options.schema ?? declarations(),
    modelNames: [ITEM, PARENT, EMPTY], declarations: [{ source: SOURCE, event: EVENT,
      binding: BINDING, from: FROM, resultType: 'TextRun', handlers }], bounds: options.bounds ?? bounds });
  const source = installed(), originId = `completion-origin-${++sequence}`;
  const request = { binding: options.binding ?? BINDING, from: options.from ?? FROM,
    arguments: options.arguments ?? { source: 'Demo.job', revision: '7' } };
  const send: SystemCommandDef = { name: 'fixture.send', stage: async (_args, ctx) => {
    const staged = await stageCanonicalSend({ operationId: originId, source: SOURCE, occurrenceIndex: 0,
      request, originOccurrence: null, ...(options.correlation === false ? {} : { correlation: {
        requestSource: 'Demo.job', requestRevision: '7', requestBinding: request.binding, requestFrom: request.from,
        requestApp: scope.app, requestOwner: scope.owner,
      } }) }, ctx);
    return { ...staged.effects, result: { deliveryId: staged.delivery.id } };
  } };
  const terminal: SystemCommandDef = { name: 'fixture.terminal', stage: async (args, ctx) => {
    const deliveryId = args['deliveryId'] as string, status = args['status'] as ReceiptStatus;
    const attempt: SystemStaging = status === 'pending' || args['withoutAttempt'] === true ? {} :
      await workDispatchRecordAttemptCommand.stage({ intentId: deliveryId, claimId: `claim-${originId}`,
        outcome: status === 'skipped' ? { state: 'pending', guardVerdict: false }
          : status === 'failed' ? { state: 'failed', retryClass: 'terminal', errorCode: 'safe-failure', errorMessage: 'Failed safely' }
          : status === 'unknown' ? { state: 'uncertain', errorCode: 'uncertain', errorMessage: 'Unknown safely' }
          : { state: 'delivered', deliveryId }, ack: status !== 'unknown' }, ctx);
    const receipt = newReceiptRow({ deliveryId, revision: systemCommandStageRevision(ctx), status,
      result: status === 'succeeded' ? resultValue() : null,
      error: status === 'failed' ? { code: 'safe-failure', message: 'Failed safely' }
        : status === 'unknown' ? { code: 'uncertain', message: 'Unknown safely' } : null,
      contentRef: null, resultExpiresAtMs: null }, { nowMs: ctx.now, actor: ctx.actor });
    return { ...attempt, writes: [...(attempt.writes ?? []), { kind: 'insert' as const,
      model: asModel(RECEIPT_MODEL), row: receipt }], result: { status } };
  } };
  const registry = createSystemRegistry([send, terminal, workDispatchClaimCommand, source]);
  let runs = 0;
  const run = (name: string, args: Record<string, unknown>, operationId = `completion-system-${sequence}-${++runs}`,
    selectedStore: StoragePort = store) => registry.run(name, args,
    { actor: member.user.user_id, now: Date.now(), operation: 'Demo.request', operationId }, { store: selectedStore });
  const sent = await run(send.name, {}, originId), deliveryId = (sent.result as { deliveryId: string }).deliveryId;
  const original = await store.outboxGet(deliveryId); assert.ok(original?.originalCommit);
  const dispatch = await store.load(WORK_DISPATCH_MODEL, asId(deliveryId)); assert.ok(dispatch);
  assert.ok(dispatch.created <= original.originalCommit.createdAt);
  const settle = async (status: ReceiptStatus = 'succeeded', withoutAttempt = false) => {
    if (status !== 'pending' && !withoutAttempt) {
      const claimed = await run(workDispatchClaimCommand.name, { intentId: deliveryId, claimId: `claim-${originId}`,
        claimedAtMs: Date.now(), maxClaimAgeMs: 60_000 });
      assert.equal((claimed.result as { claimed: boolean }).claimed, true);
    }
    await run(terminal.name, { deliveryId, status, withoutAttempt });
  };
  const issue = (selectedStore: StoragePort = store, args: Record<string, unknown> = { deliveryId }) =>
    run(source.name, args, undefined, selectedStore);
  const read = (selectedStore: StoragePort = store) => registry.read(source.name, { deliveryId },
    { actor: member.user.user_id, now: Date.now(), operation: 'Demo.request', operationId: `completion-read-${sequence}-${++runs}` },
    { store: selectedStore });
  return { store, memberships, member, scope, source, originId, handlers, deliveryId, run, settle, issue, read, installed };
}
type World = Awaited<ReturnType<typeof world>>;
async function seedContained(w: World, id: string) {
  await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'insert', model: ITEM,
    row: { ...makeRow({ id }), parent: { model: PARENT, id: asId('parent') } } }] }));
}
async function corrupt(w: World, model: ModelName, id: string, changes: Partial<StoredRow>) {
  const current = await w.store.load(model, asId(id)); assert.ok(current);
  await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'update', model, id: current.id,
    expectedVersion: current.version, row: { ...current, version: asVersion(current.version + 1), ...changes } }] }));
}

test('a genuine terminal send stages all ordinary and complete frozen cohort routes in one source fence and replay captures no new members', async () => {
  const w = await world({ routes: scope => [
    { handler: 'Demo.completed' }, { handler: 'Demo.sibling' },
    { handler: 'Demo.all', cohort: { kind: 'model', owner: scope.owner, model: ITEM } },
    { handler: 'Demo.children', cohort: { kind: 'anchored-collection', owner: scope.owner, model: ITEM,
      parent: { model: PARENT, id: 'parent' } } },
    { handler: 'Demo.empty', cohort: { kind: 'model', owner: scope.owner, model: EMPTY } },
  ] });
  await seedRow(w.store, PARENT, { id: 'parent' });
  for (const id of ['a', 'b']) await seedContained(w, id);
  await seedRow(w.store, ITEM, { id: 'outside' });
  await seedRow(w.store, ITEM, { id: 'archived', archivedAt: FIXED_NOW });
  await w.settle();
  const revision = await w.store.readRevision(), actualCommit = w.store.commit;
  let commits = 0;
  w.store.commit = async batch => {
    commits++; assert.equal(batch.expectedRevision, revision);
    assert.deepEqual(new Set(batch.writes.map(write => write.model)), new Set(framework));
    return actualCommit(batch);
  };
  const issued = await w.issue(), result = issued.result as { status: string; sourceOccurrence: string; event: string; payload: unknown };
  assert.equal(result.status, 'staged'); assert.equal(commits, 1);
  w.store.commit = actualCommit;
  const sourceOccurrence = `standard-completion/v1/${encodeURIComponent(w.deliveryId)}`;
  assert.equal(result.sourceOccurrence, sourceOccurrence); assert.equal(result.event, EVENT);
  const payload = { delivery_id: w.deliveryId, status: 'succeeded', result: resultValue(), error: null };
  assert.deepEqual(result.payload, payload);
  const receipt = await w.store.load(WORK_OCCURRENCE_MODEL, asId(sourceOccurrence)); assert.ok(receipt);
  assert.equal(readOccurrenceRow(receipt).status, 'completed');
  for (const handler of ['Demo.completed', 'Demo.sibling']) {
    const row = await w.store.load(WORK_HANDLER_OCCURRENCE_MODEL, asId(handlerOccurrenceRowId(sourceOccurrence, handler)));
    assert.ok(row); const route = readHandlerOccurrenceRow(row);
    assert.equal(route.state, 'pending'); assert.deepEqual(route.payload, payload); assert.equal(route.event, EVENT);
  }
  for (const [handler, kind, expected] of [
    ['Demo.all', 'model', ['a', 'b', 'outside']], ['Demo.children', 'anchored-collection', ['a', 'b']], ['Demo.empty', 'model', []],
  ] as const) {
    const id = fanoutIntentRowId(sourceOccurrence, handler, kind);
    const intent = await w.store.load(WORK_FANOUT_INTENT_MODEL, asId(id)); assert.ok(intent);
    assert.deepEqual(readFanoutIntentRow(intent).members, expected);
  }
  const checkpoints = await rows(w.store, WORK_FANOUT_CHECKPOINT_MODEL);
  assert.equal(checkpoints.length, 3);
  const emptyId = fanoutCheckpointRowId(fanoutIntentRowId(sourceOccurrence, 'Demo.empty', 'model'));
  assert.equal(readFanoutCheckpointRow(checkpoints.find(row => row.id === emptyId)!).cursor, null);
  const children = await rows(w.store, WORK_FANOUT_CHILD_MODEL); assert.equal(children.length, 4);
  for (const row of children) assert.equal(readFanoutChildRow(row).state, 'pending');
  await seedContained(w, 'late');
  const before = await sourceRows(w.store), query = w.store.query;
  let census = 0; w.store.query = async spec => { if ([ITEM, EMPTY].includes(spec.model)) census++; return query(spec); };
  const replay = await w.issue(); assert.equal((replay.result as { status: string }).status, 'replayed');
  w.store.query = query; assert.equal(census, 0); assert.deepEqual(await sourceRows(w.store), before);
  assert.equal(await w.store.load(WORK_FANOUT_CHILD_MODEL, asId(fanoutChildRowId(sourceOccurrence, 'Demo.all', 'late'))), null);
});

test('actual retained receipt outcomes govern success without acknowledgement, failure, skip and real nonterminal pending outcomes', async () => {
  for (const status of ['succeeded', 'failed', 'skipped', 'unknown', 'pending'] as const) {
    const w = await world(); await w.settle(status, status === 'succeeded');
    const retained = await w.store.outboxGet(w.deliveryId); assert.ok(retained);
    if (status === 'succeeded') {
      assert.equal(retained.status, 'pending');
      assert.equal(readDispatchRow((await w.store.load(WORK_DISPATCH_MODEL, asId(w.deliveryId)))!).state, 'pending');
    }
    const issued = await w.issue(), result = issued.result as { status: string; payload?: Record<string, unknown> };
    if (status === 'unknown' || status === 'pending') {
      assert.equal(result.status, 'pending');
      for (const [, records] of await sourceRows(w.store)) assert.deepEqual(records, []);
    } else {
      assert.equal(result.status, 'staged'); assert.equal(result.payload!['status'], status);
      assert.equal(result.payload!['delivery_id'], w.deliveryId);
      if (status === 'failed') assert.deepEqual(result.payload!['error'], { code: 'safe-failure', message: 'Failed safely' });
      if (status === 'skipped') assert.deepEqual(result.payload, {
        delivery_id: w.deliveryId, status: 'skipped', result: null, error: null,
      });
    }
  }
});

test('source identity, original provenance, complete typed payload and retained content failures publish no source or route', async () => {
  for (const mode of ['binding', 'from', 'input', 'dispatch-origin', 'dispatch-index', 'result-correlation', 'numeric-revision',
    'unknown-result-field', 'null-result', 'missing-result', 'content-ref', 'expired', 'receipt-future', 'missing-stamp', 'future-stamp', 'extra-args'] as const) {
    const w = await world({ ...(mode === 'binding' ? { binding: 'Demo.Foreign' } : {}),
      ...(mode === 'from' ? { from: 'deployment.foreign' } : {}),
      ...(mode === 'input' ? { arguments: { source: 'Demo.job', revision: 7 }, correlation: false } : {}) });
    await w.settle();
    if (mode === 'dispatch-origin' || mode === 'dispatch-index') {
      const row = await w.store.load(WORK_DISPATCH_MODEL, asId(w.deliveryId)); assert.ok(row);
      await corrupt(w, WORK_DISPATCH_MODEL, w.deliveryId, { data: { ...row.data,
        ...(mode === 'dispatch-origin' ? { operationId: 'foreign-original-operation' } : { occurrenceIndex: 1 }) } });
    } else if (['result-correlation', 'numeric-revision', 'unknown-result-field', 'null-result', 'missing-result', 'content-ref', 'expired', 'receipt-future'].includes(mode)) {
      const row = await w.store.load(asModel(RECEIPT_MODEL), asId(w.deliveryId)); assert.ok(row);
      const data = structuredClone(row.data) as Record<string, unknown>;
      if (mode === 'result-correlation') data['result'] = { ...resultValue(), source: 'Demo.foreign-job' };
      if (mode === 'numeric-revision') data['result'] = { ...resultValue(), revision: 7 };
      if (mode === 'unknown-result-field') data['result'] = { ...resultValue(), copiedGrant: true };
      if (mode === 'null-result') data['result'] = null;
      if (mode === 'missing-result') delete data['result'];
      if (mode === 'content-ref') data['contentRef'] = 'external-unavailable-content';
      if (mode === 'expired') data['resultExpiresAtMs'] = 0;
      if (mode === 'receipt-future') data['revision'] = (await w.store.readRevision()) + 100;
      await corrupt(w, asModel(RECEIPT_MODEL), w.deliveryId, { data });
    }
    const originalGet = w.store.outboxGet;
    const store: StoragePort = mode === 'missing-stamp' || mode === 'future-stamp' ? { ...w.store, outboxGet: async id => {
      const actual = await originalGet(id); if (actual === null) return null;
      if (mode === 'missing-stamp') { const { originalCommit: omitted, ...legacy } = actual; assert.ok(omitted); return legacy; }
      return { ...actual, originalCommit: { ...actual.originalCommit!, createdAt: Date.now() + 60_000 } };
    } } : w.store;
    await assert.rejects(w.issue(store, mode === 'extra-args' ? { deliveryId: w.deliveryId,
      payload: { delivery_id: w.deliveryId, status: 'succeeded', result: resultValue(), error: null } } : { deliveryId: w.deliveryId }), refusal, mode);
    for (const [, records] of await sourceRows(w.store)) assert.deepEqual(records, [], mode);
  }
});

test('source collisions, whole census overflow and actual winning fence conflicts reject every route atomically', async () => {
  for (const mode of ['collision', 'members', 'fence'] as const) {
    const w = await world({ routes: scope => [{ handler: 'Demo.completed' },
      { handler: 'Demo.all', cohort: { kind: 'model', owner: scope.owner, model: ITEM } }],
      ...(mode === 'members' ? { bounds: { ...bounds, maxMembers: 1 } } : {}) });
    await seedRow(w.store, ITEM, { id: 'a' }); await seedRow(w.store, ITEM, { id: 'b' }); await w.settle();
    const occurrenceId = `standard-completion/v1/${encodeURIComponent(w.deliveryId)}`;
    if (mode === 'collision') await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'insert',
      model: WORK_OCCURRENCE_MODEL, row: newOccurrenceRow({ occurrenceId, status: 'completed', result: { foreign: true },
        code: null, message: null, recordedAtMs: Date.now() }, { nowMs: Date.now(), actor: w.member.user.user_id }) }] }));
    const before = await sourceRows(w.store);
    if (mode === 'fence') {
      const actual = w.store.commit; let raced = false;
      w.store.commit = async batch => {
        if (!raced) { raced = true; await actual(makeBatch(batch.expectedRevision)); }
        return actual(batch);
      };
      await assert.rejects(w.issue(), error => error instanceof StateError && error.code === 'busy');
      w.store.commit = actual; assert.equal(raced, true);
    } else await assert.rejects(w.issue(), refusal);
    assert.deepEqual(await sourceRows(w.store), before, mode);
  }
});

test('copied and expired registry contexts cannot issue a retained completion even when a copied-context error is caught', async () => {
  const w = await world(); await w.settle();
  let captured: SystemCommandContext | undefined;
  const probe: SystemCommandDef = { name: 'fixture.copy', stage: async (_args, ctx) => {
    captured = ctx;
    await assert.rejects(Promise.resolve().then(() => w.source.stage({ deliveryId: w.deliveryId }, Object.freeze({ ...ctx }))), refusal);
    return { writes: [{ kind: 'insert', model: ITEM, row: {
      id: asId('caught-copy-must-not-commit'), version: asVersion(1), created: ctx.now, updated: ctx.now,
      createdBy: ctx.actor, updatedBy: ctx.actor, archivedAt: null, data: {},
    } }] };
  } };
  const registry = createSystemRegistry([probe]);
  await assert.rejects(registry.run(probe.name, {}, { actor: w.member.user.user_id, now: Date.now(),
    operation: 'Demo.copy', operationId: 'copied-completion' }, { store: w.store }), refusal);
  assert.equal(await w.store.load(ITEM, asId('caught-copy-must-not-commit')), null);
  assert.ok(captured);
  await assert.rejects(Promise.resolve().then(() => w.source.stage({ deliveryId: w.deliveryId }, captured!)), refusal);
  for (const [, records] of await sourceRows(w.store)) assert.deepEqual(records, []);
});

test('a retained generic Email completion validates its owning result and routes, replays, and refuses consumed declaration drift or partial routes', async () => {
  const emailSource = 'std.EmailV1.send', emailEvent = 'Demo.Mail.send.completed';
  const emailSchema = (event = emailEvent): SchemaDescriptor => ({ contracts: {
    EmailAccepted: { fields: { reference: { type: 'text' } } },
    DeliveryError: { fields: { code: { type: 'text' }, message: { type: 'text' } } },
  }, operations: {
    [emailSource]: { inputs: { to: { type: 'email' }, subject: { type: 'text' },
      body: { type: 'text' }, attachments: { type: 'file[]' } } },
    [event]: { inputs: { delivery_id: { type: 'text' }, status: { type: 'enum(succeeded,failed,unknown,skipped)' },
      result: { type: 'EmailAccepted?' }, error: { type: 'DeliveryError?' } } },
  } });
  const create = async (result: unknown = { reference: 'accepted-email-1' }) => {
    const store = createMemoryStorage(), memberships = createMemoryIdentityStore();
    const member = await seedMember(memberships, { isOwner: false });
    const scope: WorkScope = { app: 'demo-app', owner: member.team.team_id, ownerPackage: 'Demo' };
    const handlers = [{ handler: 'Demo.mailCompleted' }, { handler: 'Demo.mailSibling' }];
    const installed = (schema = emailSchema(), event = emailEvent) => createStandardCompletionSourceCommand({
      scope, schema, modelNames: [], declarations: [{ source: emailSource, event, binding: 'Demo.Mail',
        from: 'deployment.mail', resultType: 'EmailAccepted', handlers }], bounds,
    });
    const source = installed(), origin = `completion-email-origin-${++sequence}`;
    const send: SystemCommandDef = { name: 'fixture.email-send', stage: async (_args, ctx) => {
      const staged = await stageCanonicalSend({ operationId: origin, source: emailSource, occurrenceIndex: 0,
        request: { binding: 'Demo.Mail', from: 'deployment.mail', arguments: {
          to: 'reader@example.com', subject: 'Ready', body: 'The work is complete.', attachments: [],
        } }, originOccurrence: null }, ctx);
      return { ...staged.effects, result: { deliveryId: staged.delivery.id } };
    } };
    let deliveryId = '';
    const terminal: SystemCommandDef = { name: 'fixture.email-terminal', stage: async (_args, ctx) => ({
      writes: [{ kind: 'insert', model: asModel(RECEIPT_MODEL), row: newReceiptRow({ deliveryId,
        revision: systemCommandStageRevision(ctx), status: 'succeeded', result, error: null,
        contentRef: null, resultExpiresAtMs: null }, { nowMs: ctx.now, actor: ctx.actor }) }],
    }) };
    const payload = () => ({ delivery_id: deliveryId, status: 'succeeded', result, error: null });
    const partial: SystemCommandDef = { name: 'fixture.email-partial-route', stage: async (_args, ctx) => {
      const staged = await stageHandlerOccurrence({ source: { occurrenceId: `standard-completion/v1/${encodeURIComponent(deliveryId)}`,
        event: emailEvent, payload: payload(), scope }, handler: handlers[1]!.handler }, ctx);
      assert.equal(staged.status, 'ready');
      return staged.status === 'ready' ? staged.effects : {};
    } };
    const registry = createSystemRegistry([send, terminal, partial, source]);
    let runs = 0;
    const run = (name: string, args: Record<string, unknown> = {}, operationId = `completion-email-${sequence}-${++runs}`,
      selected = registry) => selected.run(name, args, { actor: member.user.user_id, now: Date.now(),
      operation: 'Demo.mailRequest', operationId }, { store });
    deliveryId = ((await run(send.name, {}, origin)).result as { deliveryId: string }).deliveryId;
    await run(terminal.name);
    assert.ok((await store.outboxGet(deliveryId))?.originalCommit);
    assert.equal(readDispatchRow((await store.load(WORK_DISPATCH_MODEL, asId(deliveryId)))!).requestSource, undefined);
    return { store, deliveryId, scope, handlers, installed, source, partial, run, payload,
      issue: () => run(source.name, { deliveryId }) };
  };
  const accepted = await create();
  const first = (await accepted.issue()).result as { status: string; sourceOccurrence: string; event: string; payload: unknown };
  assert.equal(first.status, 'staged'); assert.equal(first.event, emailEvent);
  assert.equal(first.sourceOccurrence, `standard-completion/v1/${encodeURIComponent(accepted.deliveryId)}`);
  assert.deepEqual(first.payload, accepted.payload());
  for (const route of accepted.handlers) {
    const row = await accepted.store.load(WORK_HANDLER_OCCURRENCE_MODEL,
      asId(handlerOccurrenceRowId(first.sourceOccurrence, route.handler))); assert.ok(row);
    assert.deepEqual(readHandlerOccurrenceRow(row).payload, accepted.payload());
  }
  const consumed = await sourceRows(accepted.store);
  assert.equal(((await accepted.issue()).result as { status: string }).status, 'replayed');
  assert.deepEqual(await sourceRows(accepted.store), consumed);
  for (const mode of ['alias', 'result-schema'] as const) {
    const event = mode === 'alias' ? 'Demo.RenamedMail.send.completed' : emailEvent;
    const originalSchema = emailSchema(event);
    const schema: SchemaDescriptor = mode === 'result-schema' ? { ...originalSchema, contracts: {
      ...originalSchema.contracts, EmailAccepted: { fields: { reference: { type: 'email' } } },
    } } : originalSchema;
    const changed = accepted.installed(schema, event), registry = createSystemRegistry([changed]);
    await assert.rejects(accepted.run(changed.name, { deliveryId: accepted.deliveryId }, undefined, registry), refusal, mode);
    assert.deepEqual(await sourceRows(accepted.store), consumed, mode);
  }
  for (const result of [null, { reference: 'accepted-email-1', foreign: true }]) {
    const invalid = await create(result);
    await assert.rejects(invalid.issue(), refusal);
    for (const [, records] of await sourceRows(invalid.store)) assert.deepEqual(records, []);
  }
  const partial = await create(); await partial.run(partial.partial.name);
  const preexisting = await sourceRows(partial.store);
  await assert.rejects(partial.issue(), refusal);
  assert.deepEqual(await sourceRows(partial.store), preexisting);
  assert.equal((await rows(partial.store, WORK_OCCURRENCE_MODEL)).length, 0);
  assert.equal((await rows(partial.store, WORK_HANDLER_OCCURRENCE_MODEL)).length, 1);
});


test('genuine read-only completion returns the detached consumed original after current receipt expiry with no commit or census', async () => {
  const w = await world({ routes: scope => [{ handler: 'Demo.completed' },
    { handler: 'Demo.all', cohort: { kind: 'model', owner: scope.owner, model: ITEM } }] });
  await seedRow(w.store, ITEM, { id: 'original' }); await w.settle(); await w.issue();
  const sourceId = `standard-completion/v1/${encodeURIComponent(w.deliveryId)}`;
  const stored = await w.store.load(WORK_OCCURRENCE_MODEL, asId(sourceId)); assert.ok(stored);
  const original = readOccurrenceRow(stored);
  const current = await w.store.load(asModel(RECEIPT_MODEL), asId(w.deliveryId)); assert.ok(current);
  await corrupt(w, asModel(RECEIPT_MODEL), w.deliveryId, { data: { ...current.data, resultExpiresAtMs: 0 } });
  await seedRow(w.store, ITEM, { id: 'later' });
  const revision = await w.store.readRevision(), before = await sourceRows(w.store);
  let commits = 0, queries = 0, receiptReads = 0;
  const selected: StoragePort = { ...w.store,
    commit: async batch => { commits++; return w.store.commit(batch); },
    query: async spec => { queries++; return w.store.query(spec); },
    load: async (model, id) => { if (model === RECEIPT_MODEL) receiptReads++; return w.store.load(model, id); },
  };
  const read = await w.read(selected);
  assert.equal(read.revision, revision); assert.deepEqual(read.result, original);
  assert.notEqual(read.result, original); assert.ok(Object.isFrozen(read.result));
  const source = (read.result as typeof original).result as Record<string, unknown>;
  assert.ok(Object.isFrozen(source)); assert.ok(Object.isFrozen(source['payload']));
  assert.equal(commits, 0); assert.equal(queries, 0); assert.equal(receiptReads, 0);
  assert.equal(await w.store.readRevision(), revision); assert.deepEqual(await sourceRows(w.store), before);
  // Fenced replay uses the same consumed validator and still avoids fresh capture.
  assert.equal(((await w.issue()).result as { status: string }).status, 'replayed');
});

test('missing consumption refuses before reading the current receipt or capturing any cohort', async () => {
  const w = await world({ routes: scope => [{ handler: 'Demo.all', cohort: { kind: 'model', owner: scope.owner, model: ITEM } }] });
  await w.settle();
  const revision = await w.store.readRevision(); let receiptReads = 0, queries = 0, commits = 0;
  const selected: StoragePort = { ...w.store,
    load: async (model, id) => { if (model === RECEIPT_MODEL) receiptReads++; return w.store.load(model, id); },
    query: async spec => { queries++; return w.store.query(spec); },
    commit: async batch => { commits++; return w.store.commit(batch); },
  };
  await assert.rejects(w.read(selected), /has not been consumed/);
  assert.equal(receiptReads, 0); assert.equal(queries, 0); assert.equal(commits, 0);
  assert.equal(await w.store.readRevision(), revision);
  for (const [, records] of await sourceRows(w.store)) assert.deepEqual(records, []);
});

test('consumed read and replay share complete route validation and reject forged or closed contexts', async () => {
  const w = await world(); await w.settle(); await w.issue();
  let issued!: SystemCommandContext;
  const probe: SystemCommandDef = { name: 'fixture.read-probe', stage: () => ({}), read: async (_args, ctx) => {
    issued = ctx;
    await assert.rejects(w.source.read({ deliveryId: w.deliveryId }, { ...ctx }), refusal);
    return null;
  } };
  const ctx = { actor: w.member.user.user_id, now: Date.now(), operation: 'Demo.request', operationId: 'completion-forged-read' };
  await assert.rejects(createSystemRegistry([probe]).read(probe.name, {}, ctx, { store: w.store }), refusal);
  await assert.rejects(w.source.read({ deliveryId: w.deliveryId }, issued), refusal);
  const id = handlerOccurrenceRowId(`standard-completion/v1/${encodeURIComponent(w.deliveryId)}`, w.handlers[0]!.handler);
  const route = await w.store.load(WORK_HANDLER_OCCURRENCE_MODEL, asId(id)); assert.ok(route);
  await corrupt(w, WORK_HANDLER_OCCURRENCE_MODEL, id, { data: { ...route.data, event: 'Demo.foreign.completed' } });
  const revision = await w.store.readRevision(), before = await sourceRows(w.store);
  await assert.rejects(w.read(), /consumed ordinary route differs/);
  await assert.rejects(w.issue(), /consumed ordinary route differs/);
  assert.equal(await w.store.readRevision(), revision); assert.deepEqual(await sourceRows(w.store), before);
});
