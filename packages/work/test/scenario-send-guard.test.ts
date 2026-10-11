/** Defining State/Work component fixture. No original-source/native acceptance claim. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoundCapabilityRequest, CanTypeId, DeliveryRef, FileReferenceInventory, FrameworkOpaqueDeliveryContext, FrameworkOpaqueDeliveryProfile, FrameworkOpaquePayloadOrigin, FrameworkFilePayloadOrigin, Revision, StoredRow } from '@canlang/contracts';
import { encodeValue, makeUserRef, makeDeliveryRef, SchemaError } from '@canlang/values';
import { createFrozenClock, createMemoryIdentityStore as createOwningMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { STATE_FILE_REFERENCE_PRODUCER, prepareFrameworkFilePayloadOrigin } from '@canlang/state/storage';
import { WORK_FILE_REFERENCE_PRODUCER } from '../src/kernel/file-reference-inventory.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice, type GeneratedOperationDef } from '@canlang/state/invocation/registry';
import { buildModelTableFromCanonical } from '@canlang/state/mutation/models';
import { buildPolicyTable } from '@canlang/state/policy/grants';
import { beginScenarioReceiptMutation, bindScenarioReceiptFrameworkProducer, invoke,
  selectScenarioReceiptReturn, stageScenarioReceiptDelivery, stageScenarioReceiptSend,
  bindScenarioReceiptSendMembershipProducer, evaluateScenarioReceiptSendMembership,
  bindScenarioReceiptReferenceProducer,
  type AdmittedCall, type ExecutionEffects } from '@canlang/state/invocation';
import { StateError } from '@canlang/state/errors';
import { RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL, readAssociationRow, readReceiptRow, withAssociationRowData, withReceiptRowData } from '@canlang/state/receipt/tables';
import { asId, asModel, FIXED_NOW, createMemoryIdentityStore, makeIdentity, makeEnvelope, seedMember, uuidv7, makeBatch, asOperation } from '@canlang/state/testing/invocation/fixtures';
import { stageCanonicalSend, readCanonicalSendStaging } from '../src/kernel/dispatch-staging.js';
import { WORK_DISPATCH_MODEL, readDispatchRow, readDispatchSourceGuard } from '../src/kernel/tables.js';

const MODEL = asModel('Guarded.Run'), ID = asId('run'), OP = 'Guarded.generate', APP = 'guarded-component';
const TARGET = 'std.TextGenerationV1.generate', BINDING = 'Guarded.Writer', FROM = 'writer-install';
const source = { path: 'guarded.can', sha256: 'b'.repeat(64), module: 'guarded.mjs' };
const rule = 'Guarded.generate.send.0', node = { start: 10, end: 30 };
const guard = { rule, source, owner: OP, node, binding: BINDING, target: TARGET,
  inputs: [{ name: 'subject', type: 'user' as CanTypeId }, { name: 'enabled', type: 'bool' as CanTypeId }] };
const modelGuard = { ...guard, inputs: [{ name: 'run', type: MODEL as CanTypeId }, { name: 'enabled', type: 'bool' as CanTypeId }] };
const OTHER_MODEL = asModel('Guarded.Other');
let sequence = 82000;
const textResult = { name: 'TextRun', fields: [
  { name: 'source', type: 'text' as CanTypeId }, { name: 'revision', type: 'int' as CanTypeId },
  { name: 'sequence', type: 'int' as CanTypeId },
  { name: 'state', type: 'enum(queued,running,succeeded,failed,unknown,cancelled)' as CanTypeId },
  { name: 'content', type: 'text' as CanTypeId }, { name: 'used_tokens', type: 'int?' as CanTypeId },
  { name: 'detail', type: 'text?' as CanTypeId },
] };
function artifact(modelSnapshot = false): ArtifactDescriptorSlice {
  return { artifact_version: 1, valueTypes: { contracts: [textResult] }, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const identity="Guarded.generate";', map: {
      version: 3, file: source.module, sources: [source.path], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: source.module, export: 'identity', member: ['generate'] }],
    models: [{ name: MODEL, deleteMode: 'archive', fields: [
      { name: 'title', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: true, serverOnly: false },
      { name: 'request', field: { kind: 'delivery', capability: 'std.TextGenerationV1', operation: 'generate', version: 1,
        result: textResult }, required: !modelSnapshot, nullable: modelSnapshot, serverOnly: false },
      ...(modelSnapshot ? [
        { name: 'author', field: { kind: 'user' as const }, valueType: 'user' as CanTypeId, required: true, serverOnly: false },
        { name: 'stop_requested', field: { kind: 'boolean' as const }, valueType: 'bool' as CanTypeId, required: true, serverOnly: false },
      ] : []),
    ] }, ...(modelSnapshot ? [{ name: OTHER_MODEL, deleteMode: 'archive' as const, fields: [
      { name: 'title', field: { kind: 'string' as const }, required: true, serverOnly: false },
    ] }] : [])], operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [] },
      result: { type: 'void' as CanTypeId, disclosure: { version: 1, source,
        returns: [{ id: 'done', source, dependencies: [], influences: [] }] } } }],
  };
}
function request(): BoundCapabilityRequest {
  return { binding: BINDING, from: FROM, arguments: { value: { source: 'run-request', revision: '7', prompt: 'Generate' } } };
}
async function world(mode: 'plain' | 'membership' | 'model' = 'plain', verdict = true, initiallyActive = true, receiptMode: 'ordinary' | 'wrong-association' | 'advance-revision' = 'ordinary', profileMode: 'exact' | 'generation-profile' = 'exact') {
  const { memberships, actor, subject, member } = await (async () => {
    if (mode === 'model') {
      const memberships = createOwningMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
      const team = await memberships.createTeam({ timezone: 'UTC' });
      const user = await memberships.createUser({ email: 'guard-caller@example.test', password_hash: 'component-fixture', email_verified: true });
      const membership = await memberships.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
      const subject = await memberships.createUser({ email: 'guard-subject@example.test', password_hash: 'component-fixture', email_verified: true });
      const member = initiallyActive ? await memberships.createMembership({ team_id: team.team_id, user_id: subject.user_id, is_owner: false, roles: [] }) : null;
      return { memberships, actor: { user, team, membership }, subject, member };
    }
    const memberships = createMemoryIdentityStore(), actor = await seedMember(memberships, { isOwner: false });
    const subject = await memberships.createUser('guard-subject@example.test');
    const member = initiallyActive ? await memberships.createMembership({ team_id: actor.team.team_id, user_id: subject.user_id, is_owner: false, roles: [] }) : null;
    return { memberships, actor, subject, member };
  })();
  const authority = { app: APP, stateOwner: 'Guarded', stateStoreId: 'guarded-state', fileStoreId: 'guarded-files',
    receiver: { app: APP, team: actor.team.team_id, owner: actor.team.team_id } };
  const producers = [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER];
  const { store, probe } = createTestMemoryStorage(authority, producers);
  const original = artifact(mode === 'model'), loaded = loadArtifactDescriptors(original, { by: 'members' });
  const selectedGuard = mode === 'model' ? modelGuard : guard;
  const def = loaded.registry.get(OP)! as GeneratedOperationDef;
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields, containment: loaded.containment,
    ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }) });
  const identity = { owner: authority.stateOwner, snapshotId: 'guarded-original', digest: 'guarded-original-digest' };
  const snapshot = { ...identity, installedAt: FIXED_NOW, installedRevision: 1 as Revision };
  const authored = original.operations!.find(operation => operation.name === OP)!;
  const callable = original.callables!.find(operation => operation.id === OP)!;
  const owningModel = original.models!.find(model => model.name === MODEL)!;
  const deliveryField = owningModel.fields.find(field => field.name === 'request')!;
  assert.equal(deliveryField.field.kind, 'delivery');
  if (deliveryField.field.kind !== 'delivery' || 'judgment' in deliveryField.field) throw new Error('Actual generation delivery declaration required.');
  const originalDelivery = deliveryField.field;
  const canonicalDelivery = loaded.models.find(model => model.name === MODEL)!.fields.request!.delivery;
  assert.ok(canonicalDelivery && !('judgment' in canonicalDelivery));
  const declaration: FrameworkOpaqueDeliveryContext = { kind: 'generation', canonical: canonicalDelivery,
    artifact: originalDelivery, request: { source: 'run-request', revision: '7' } };
  const installedDelivery: FrameworkOpaqueDeliveryProfile = profileMode === 'exact' ? declaration :
    { kind: 'generation-profile', canonical: canonicalDelivery, artifact: originalDelivery };
  assert.equal(def.descriptor.result?.type, 'void'); assert.equal(authored.result?.type, 'void');
  const callerResult = 'guarded/caller/void', providerResult = 'guarded/provider/result', guardInputs = 'guarded/send/inputs';
  const caller = { source, callable, canonical: def.descriptor, artifact: authored, resultDeclarationId: callerResult };
  const callerSource = { kind: 'callable' as const, source, callable };
  const inventory: FileReferenceInventory = { ...identity, canonicalModels: loaded.models, artifactModels: original.models!,
    valueTypes: loaded.valueTypes!, frameworkModels: producers.flatMap(producer => producer.models), opaqueDeclarationSets: [{
      id: 'guarded/original', inventory: identity, snapshot, sources: original.sources!, canonicalModels: loaded.models,
      artifactModels: original.models!, valueTypes: loaded.valueTypes!, originalContracts: {
        TextRun: { fields: Object.fromEntries(textResult.fields.map(field => [field.name, { type: field.type }])) },
      }, valueDefaults: [], declarations: [
        { id: 'guarded/caller/inputs', source: callerSource,
          profile: { kind: 'inputs', canonical: def.descriptor.inputs, artifact: authored.inputs.fields } },
        { id: callerResult, source: callerSource,
          profile: { kind: 'void', canonical: { ...def.descriptor.result!, type: 'void' }, artifact: { ...authored.result!, type: 'void' } } },
        { id: providerResult, source: { kind: 'delivery', source, context: installedDelivery },
          profile: { kind: 'provider-result', canonical: canonicalDelivery.result, artifact: originalDelivery.result } },
        { id: guardInputs, source: { kind: 'send-guard', ...selectedGuard }, profile: { kind: 'inputs', canonical: [
          ...(mode === 'model' ? [{ name: 'run', kind: 'ref' as const, model: MODEL, versioned: true, required: true }] :
            [{ name: 'subject', kind: 'user' as const, valueType: 'user', required: true }]),
          { name: 'enabled', kind: 'boolean', valueType: 'bool', required: true },
        ], artifact: [
          ...(mode === 'model' ? [{ name: 'run', field: { kind: 'ref' as const, model: MODEL, requireVersion: true }, valueType: MODEL, required: true }] :
            [{ name: 'subject', field: { kind: 'user' as const }, valueType: 'user', required: true }]),
          { name: 'enabled', field: { kind: 'boolean' }, valueType: 'bool', required: true },
        ] } },
      ],
    }] };
  await store.installFileReferenceInventory({ expectedRevision: await store.readRevision(), authority, snapshot, inventory });
  const preparedOrigins: FrameworkFilePayloadOrigin[] = [];
  let receiptPreparations = 0;
  const externalSchedule = 'guarded/external-receipt-origin';
  const scope = { app: APP, owner: actor.team.team_id, ownerPackage: identity.owner };
  let receiptOriginMutation: ((origin: FrameworkOpaquePayloadOrigin) => FrameworkOpaquePayloadOrigin) | undefined;
  let receiptScope: typeof scope | undefined;
  const pairs = new WeakMap<AdmittedCall, { person: ReturnType<typeof makeUserRef>; team: NonNullable<AdmittedCall['context']['team']> }>();
  let handles: ReturnType<typeof bindScenarioReceiptSendMembershipProducer>, calls = 0, stages = 0, captures = 0;
  let duringGuard: (() => Promise<void>) | undefined;
  let foreignSite: ReturnType<typeof bindScenarioReceiptSendMembershipProducer>[number] | undefined;
  const modelAccess = { allowed: true, sendAttempts: 0 }, guardSnapshots: StoredRow[] = [];
  bindScenarioReceiptFrameworkProducer(def, { source, app: APP,
    bindings: [{ binding: BINDING, from: FROM, targets: [{ source: TARGET, correlation: 'value' }] }],
    sendGuards: [selectedGuard], evaluateGuard: async ({ call, inputs }) => {
      calls++;
      const enabled = inputs.enabled === true;
      let allowed = enabled && verdict;
      if (mode === 'model') {
        const row = inputs.run as StoredRow;
        assert.ok(Object.isFrozen(row)); assert.ok(Object.isFrozen(row.data));
        assert.equal(row.id, ID); assert.ok(Number.isInteger(row.version));
        assert.deepEqual(row.data.author, encodeValue('user', makeUserRef(subject.user_id)));
        guardSnapshots.push(structuredClone(row));
        allowed = allowed && row.data.stop_requested === false;
      }
      if (mode === 'membership' && enabled) {
        assert.ok(call.context.team);
        pairs.set(call, { person: makeUserRef((inputs.subject as { id: string }).id), team: call.context.team });
        allowed = await evaluateScenarioReceiptSendMembership(call, store, { site: foreignSite ?? handles[0]! });
      }
      await duringGuard?.(); return allowed;
    }, stage: async (input, context) => { stages++; return stageCanonicalSend(input, context, {
      prepareSourceGuardOrigin: async (row, intent) => prepareFrameworkFilePayloadOrigin(store, {
        expectedRevision: await store.readRevision(), inventoryOwner: identity.owner, declarationSetId: 'guarded/original',
        model: WORK_DISPATCH_MODEL, row, field: 'sourceGuard', scope, files: [],
        origin: { kind: 'send-guard', declaration: selectedGuard, inputsDeclarationId: guardInputs, intent: {
          intentId: intent.intentId, operation: intent.operation, operationId: intent.operationId, target: intent.target,
          occurrenceIndex: intent.occurrenceIndex, dispatchGuard: intent.dispatchGuard! } },
      }),
    }); }, read: readCanonicalSendStaging,
    prepareReceiptOrigin: async ({ call, row, record, field, value, revision, send }) => {
      receiptPreparations++;
      const association = { model: MODEL, recordId: receiptMode === 'wrong-association' ? asId('different-run') : record.id, field };
      let runtimeDeclaration = declaration;
      if (profileMode === 'generation-profile') {
        const args = 'intentId' in send ? send.arguments.arguments : send.request?.arguments;
        assert.ok(args && typeof args === 'object');
        const value = (args as Record<string, unknown>).value;
        assert.ok(value && typeof value === 'object');
        const correlation = value as Record<string, unknown>;
        assert.equal(typeof correlation.source, 'string'); assert.equal(typeof correlation.revision, 'string');
        runtimeDeclaration = { kind: 'generation', canonical: canonicalDelivery, artifact: originalDelivery,
          request: { source: correlation.source as string, revision: correlation.revision as string } };
      }
      const common = { deliveryId: value.id, caller, association, declaration: runtimeDeclaration, resultDeclarationId: providerResult };
      let origin: FrameworkOpaquePayloadOrigin;
      if ('intentId' in send) {
        assert.ok(typeof send.arguments.binding === 'string' && typeof send.arguments.from === 'string');
        origin = { kind: 'delivery-result', ...common, request: { binding: send.arguments.binding, from: send.arguments.from },
          intent: { intentId: send.intentId, operation: send.operation, operationId: send.operationId,
            target: send.target, occurrenceIndex: send.occurrenceIndex } };
      } else {
        assert.ok(send.request && send.guard && send.occurrenceIndex !== undefined);
        assert.equal(send.operationId, call.context.operationId);
        origin = { kind: 'delivery-skipped', ...common, request: { binding: send.request.binding, from: send.request.from },
          send: { operation: send.operation, operationId: call.context.operationId, target: send.target,
            occurrenceIndex: send.occurrenceIndex }, guard: send.guard };
      }
      origin = receiptOriginMutation?.(origin) ?? origin;
      const header = await prepareFrameworkFilePayloadOrigin(store, { expectedRevision: revision as Revision, inventoryOwner: identity.owner,
        declarationSetId: 'guarded/original', model: asModel(RECEIPT_MODEL), row, field: 'result', scope: receiptScope ?? scope, origin, files: [] });
      preparedOrigins.push(header);
      if (receiptMode === 'advance-revision') {
        // This independent durable writer survives; the abandoned invocation has no effects.
        await store.commit(makeBatch(await store.readRevision(), { schedules: [{ op: 'replace', key: externalSchedule,
          at: FIXED_NOW, event: asOperation(OP), payload: {} }] }));
      }
      return header;
    },
  });
  if (mode === 'model') {
    const fields = ['title', 'request', 'author', 'stop_requested'];
    const policy = buildPolicyTable([{ model: MODEL, secretFields: [], grants: [{ by: 'members', fields }] }]);
    bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies: new Map([[MODEL, {
      fields, secretFields: [], grants: [{ fields: ['id', ...fields], read: async ({ context, row }) => {
        // This literal component adapter interprets its declared user wire.
        assert.deepEqual(row.data.author, encodeValue('user', makeUserRef(subject.user_id)));
        return modelAccess.allowed && (await context.memberships.findMembership(actor.team.team_id, subject.user_id))?.status === 'active';
      } }],
    }]]) });
  }
  if (mode === 'membership') handles = bindScenarioReceiptSendMembershipProducer(def, { source, app: APP,
    sites: [{ version: 1, source, owner: OP, node, statement: { start: 9, end: 31 }, stage: 'send-dispatch', position: [], calls: [{
      source, node: { start: 11, end: 29 }, target: { kind: 'builtin', id: 'active_member', overload: 0 },
      arguments: [{ node: { start: 12, end: 13 }, type: 'user' }, { node: { start: 14, end: 15 }, type: 'Team' }],
      slots: [0, 1], defaults: [], chain: [],
    }] }], capture: call => {
      captures++; const pair = pairs.get(call); pairs.delete(call);
      if (pair === undefined) throw new StateError('validation', 'No fresh source SEND native pair.'); return pair;
    } });
  return { store, probe, memberships, actor, subject, member, table, pairs, preparedOrigins, externalSchedule, modelAccess, guardSnapshots,
    get receiptPreparations() { return receiptPreparations; },
    set receiptOriginMutation(value: ((origin: FrameworkOpaquePayloadOrigin) => FrameworkOpaquePayloadOrigin) | undefined) { receiptOriginMutation = value; },
    set receiptScope(value: typeof scope | undefined) { receiptScope = value; },
    get calls() { return calls; }, get stages() { return stages; }, get captures() { return captures; },
    get handles() { return handles; }, set foreignSite(value: ReturnType<typeof bindScenarioReceiptSendMembershipProducer>[number]) { foreignSite = value; }, set duringGuard(value: (() => Promise<void>) | undefined) { duringGuard = value; },
    registry: loaded.registry, app: APP, source: 'guard component fixture', clock: { nowMs: () => FIXED_NOW },
    identity: makeIdentity({ userId: actor.user.user_id, team: actor.team, membership: actor.membership }),
    envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), {}) };
}
type World = Awaited<ReturnType<typeof world>>;
test('guarded SEND refuses an owner stage advanced during its final revision await before Work allocation', async () => {
  const w = await world();
  const readRevision = w.store.readRevision;
  let release!: () => void, entered!: () => void;
  const suspended = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  w.duringGuard = async () => {
    w.store.readRevision = async () => {
      w.store.readRevision = readRevision;
      const revision = await readRevision(); entered(); await suspended; return revision;
    };
  };
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds: { maxRows: 10, maxWork: 1000 } });
    const send = stageScenarioReceiptSend(call, w.store, { source: TARGET, request: request(),
      when: { rule, inputs: { subject: encodeValue('user', makeUserRef(w.subject.user_id)), enabled: true } } });
    // Attach the rejection observer before releasing the suspended read.
    const refusal = assert.rejects(send, /original source stage while checking the revision/);
    await started;
    try {
      await session.stage({ op: 'create', model: MODEL, id: ID, data: { title: 'Uncommitted competing stage',
        request: encodeValue(`delivery(${TARGET})`, makeDeliveryRef('uncommitted', TARGET)) } }, { cause: 'scenario' });
    } finally { release(); }
    await refusal;
    await assert.rejects(session.finalize(), error => error instanceof StateError);
    throw new StateError('validation', 'Advanced original SEND stage cannot commit.');
  } }), error => error instanceof StateError);
  assert.equal(w.stages, 0);
  assert.deepEqual(await effects(w), { rows: [], dispatch: [], receipts: [], associations: [], outbox: [] });
});
async function run(w: World, options: { enabled?: boolean; lateRequire?: boolean; reportRule?: string; carrier?: BoundCapabilityRequest;
  lexical?: Record<string, unknown>; repeatDelivery?: boolean; recordId?: string; envelope?: ReturnType<typeof makeEnvelope> } = {}) {
  let delivery: DeliveryRef | undefined, active: AdmittedCall | undefined;
  const recordId = asId(options.recordId ?? ID);
  const outcome = await invoke({ ...w, envelope: options.envelope ?? w.envelope, execute: async call => {
    active = call;
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds: { maxRows: 10, maxWork: 1000 } });
    delivery = await stageScenarioReceiptSend(call, w.store, { source: TARGET, request: options.carrier ?? request(),
      when: { rule: options.reportRule ?? rule, inputs: options.lexical ?? {
        subject: encodeValue('user', makeUserRef(w.subject.user_id)), enabled: options.enabled ?? true,
      } } });
    assert.ok(delivery);
    await session.stage({ op: 'create', model: MODEL, id: recordId, data: { title: 'Run',
      request: encodeValue(`delivery(${TARGET})`, delivery) } }, { cause: 'scenario' });
    const row = await session.views.final.get(MODEL, recordId); assert.ok(row);
    await stageScenarioReceiptDelivery(call, w.store, { model: MODEL, row, field: 'request' });
    if (options.repeatDelivery) await stageScenarioReceiptDelivery(call, w.store, { model: MODEL, row, field: 'request' });
    if (options.lateRequire) throw new StateError('forbidden', 'Late authored requirement refused.');
    selectScenarioReceiptReturn(call, w.store, 'done');
    const effects = await session.finalize(); return { ...effects, result: null, outbox: effects.outbox ?? [] } as ExecutionEffects;
  } });
  return { outcome, delivery, active };
}
async function effects(w: World) {
  return { rows: await w.store.query({ model: MODEL, authority: 'owner' }),
    dispatch: await w.store.query({ model: WORK_DISPATCH_MODEL, authority: 'owner' }),
    receipts: await w.store.query({ model: asModel(RECEIPT_MODEL), authority: 'owner' }),
    associations: await w.store.query({ model: asModel(RECEIPT_ASSOCIATION_MODEL), authority: 'owner' }), outbox: w.probe.outboxAll() };
}

test('false source SEND binds a nonnullable skipped receipt without entering Work', async () => {
  const w = await world('plain', false), result = await run(w);
  assert.equal(result.outcome.status, 'committed'); assert.ok(result.delivery);
  assert.equal(w.calls, 1); assert.equal(w.stages, 0);
  const saved = await effects(w); assert.equal(saved.rows.length, 1); assert.equal(saved.dispatch.length, 0);
  assert.deepEqual(saved.outbox, []); assert.equal(saved.receipts.length, 1); assert.equal(saved.associations.length, 1);
  const associated = readAssociationRow(saved.associations[0]!);
  assert.equal(associated.deliveryId, result.delivery.id);
  const progress = readReceiptRow(saved.receipts[0]!).receipt;
  assert.equal(progress.status, 'skipped'); assert.equal(progress.result, null); assert.equal(progress.error, null);
  assert.equal(progress.deliveryId, result.delivery.id);
  const origin = readReceiptRow(saved.receipts[0]!).filePayloadOrigin; assert.ok(origin);
  assert.equal(origin.origin.kind, 'delivery-skipped');
  if (origin.origin.kind !== 'delivery-skipped') assert.fail('Original skipped SEND origin required.');
  assert.equal(origin.origin.send.occurrenceIndex, 0); assert.deepEqual(origin.origin.guard, guard);
  assert.deepEqual(origin.origin.association, { model: MODEL, recordId: ID, field: 'request' });
  assert.deepEqual(saved.rows[0]!.data.request, encodeValue(`delivery(${TARGET})`, result.delivery));
});

test('true SEND retains original lexical inputs separately from provider arguments and replay performs no new guard', async () => {
  const w = await world(), lexical = { subject: encodeValue('user', makeUserRef(w.subject.user_id)), enabled: true };
  const original = structuredClone(lexical), carrier = request();
  w.duringGuard = async () => { lexical.enabled = false; (carrier.arguments as Record<string, unknown>).value = { prompt: 'mutated' }; };
  const result = await run(w, { lexical, carrier }); assert.equal(result.outcome.status, 'committed');
  const saved = await effects(w); assert.equal(w.calls, 1); assert.equal(w.stages, 1); assert.equal(saved.dispatch.length, 1);
  const retained = readDispatchRow(saved.dispatch[0]!), sourceGuard = readDispatchSourceGuard(saved.dispatch[0]!.data); assert.ok(sourceGuard);
  assert.deepEqual(sourceGuard.inputs, original); assert.equal(sourceGuard.rule, rule);
  assert.equal(retained.sourceGuard?.rule, rule); assert.equal(retained.guardVerdict, true);
  assert.equal(retained.filePayloadOrigin?.origin.kind, 'send-guard');
  const receiptOrigin = readReceiptRow(saved.receipts[0]!).filePayloadOrigin; assert.ok(receiptOrigin);
  assert.equal(receiptOrigin.origin.kind, 'delivery-result');
  assert.equal(saved.outbox[0]!.dispatchGuard, rule);
  assert.deepEqual(saved.outbox[0]!.arguments, request());
  const before = await effects(w);
  assert.equal((await run(w)).outcome.status, 'replayed'); assert.equal(w.calls, 1);
  assert.deepEqual(await effects(w), before);
});

test('source SEND guard short circuits and current positive/negative membership decisions fence the outer commit', async () => {
  for (const mode of ['lazy', 'revoke', 'activate'] as const) {
    const w = await world('membership', true, mode !== 'activate');
    w.duringGuard = mode === 'revoke' ? async () => w.memberships.removeMembership(w.member!.membership_id) :
      mode === 'activate' ? async () => { await w.memberships.createMembership({ team_id: w.actor.team.team_id,
        user_id: w.subject.user_id, is_owner: false, roles: [] }); } : undefined;
    if (mode === 'lazy') { const result = await run(w, { enabled: false });
      assert.equal(result.outcome.status, 'committed'); assert.equal(w.captures, 0); assert.equal(w.stages, 0); }
    else { await assert.rejects(run(w), error => error instanceof StateError && error.code === 'forbidden');
      const saved = await effects(w);
      assert.deepEqual(saved.rows, []); assert.deepEqual(saved.dispatch, []); assert.deepEqual(saved.receipts, []);
      assert.deepEqual(saved.associations, []); assert.deepEqual(saved.outbox, []); }
  }
});

test('late requirement rolls back business, skipped receipts and true dispatch effects together', async () => {
  for (const verdict of [true, false]) {
    const w = await world('plain', verdict);
    await assert.rejects(run(w, { lateRequire: true }), error => error instanceof StateError && error.code === 'forbidden');
    assert.deepEqual(await effects(w), { rows: [], dispatch: [], receipts: [], associations: [], outbox: [] });
  }
});

test('wrong source rule, binding and typed lexical values refuse before Work staging', async () => {
  for (const mode of ['rule', 'binding', 'typed'] as const) {
    const w = await world();
    await assert.rejects(run(w, mode === 'rule' ? { reportRule: 'foreign-rule' } : mode === 'binding'
      ? { carrier: { ...request(), binding: 'foreign-binding' } }
      : { lexical: { subject: { id: w.subject.user_id }, enabled: 'true' } }),
    error => mode === 'typed' ? error instanceof SchemaError : error instanceof StateError && error.code === 'validation');
    assert.equal(w.stages, 0);
    assert.deepEqual(await effects(w), { rows: [], dispatch: [], receipts: [], associations: [], outbox: [] });
  }
});

test('source SEND membership handles refuse foreign and closed owner lifetimes', async () => {
  const w = await world('membership'), foreign = await world('membership');
  w.foreignSite = foreign.handles[0]!;
  await assert.rejects(run(w), error => error instanceof StateError && error.code === 'validation');
  assert.equal(w.stages, 0);
  assert.deepEqual(await effects(w), { rows: [], dispatch: [], receipts: [], associations: [], outbox: [] });
  const completed = await world('membership'), result = await run(completed); assert.equal(result.outcome.status, 'committed');
  assert.ok(result.active);
  await assert.rejects(evaluateScenarioReceiptSendMembership(result.active, completed.store, { site: completed.handles[0]! }),
    error => error instanceof StateError);
});

for (const verdict of [true, false]) test(`${verdict ? 'pending' : 'skipped'} receipt refuses a genuinely prepared header for another owning record`, async () => {
  const w = await world('plain', verdict, true, 'wrong-association');
  await assert.rejects(run(w), error => error instanceof StateError && error.code === 'validation');
  assert.equal(w.receiptPreparations, 1); assert.equal(w.preparedOrigins.length, 1);
  const origin = w.preparedOrigins[0]!.origin;
  assert.ok(origin.kind === 'delivery-result' || origin.kind === 'delivery-skipped');
  assert.equal(origin.association.recordId, 'different-run');
  assert.deepEqual(await effects(w), { rows: [], dispatch: [], receipts: [], associations: [], outbox: [] });
});

test('receipt preparation cannot return across a physical State revision advance', async () => {
  const w = await world('plain', true, true, 'advance-revision');
  const revision = await w.store.readRevision();
  await assert.rejects(run(w), error => error instanceof StateError && error.code === 'busy' && error.retryable === true);
  assert.ok(w.receiptPreparations > 0); assert.equal(w.preparedOrigins.length, w.receiptPreparations);
  assert.equal(await w.store.readRevision(), revision + w.receiptPreparations);
  assert.ok(await w.store.scheduleGet(w.externalSchedule), 'The independent revision writer remains durable.');
  assert.deepEqual(await effects(w), { rows: [], dispatch: [], receipts: [], associations: [], outbox: [] });
});

for (const verdict of [true, false]) test(`${verdict ? 'pending' : 'skipped'} receipt stages twice with one original origin preparation and identity`, async () => {
  const w = await world('plain', verdict), result = await run(w, { repeatDelivery: true });
  assert.equal(result.outcome.status, 'committed'); assert.ok(result.delivery);
  assert.equal(w.receiptPreparations, 1); assert.equal(w.preparedOrigins.length, 1);
  const saved = await effects(w); assert.equal(saved.receipts.length, 1); assert.equal(saved.associations.length, 1);
  const retained = readReceiptRow(saved.receipts[0]!);
  assert.equal(retained.receipt.deliveryId, result.delivery.id);
  assert.deepEqual(retained.filePayloadOrigin, w.preparedOrigins[0]);
  assert.equal(readAssociationRow(saved.associations[0]!).deliveryId, result.delivery.id);
  assert.equal(retained.receipt.status, verdict ? 'pending' : 'skipped');
});

/** The literal evaluator above consumes a canonical StoredRow snapshot. It is
 * an installed component adapter, not an original Can/native guard issuer. */
async function runModel(w: World, options: { stop?: boolean; invalid?: 'copy' | 'stale' | 'foreign' | 'bare';
  catchInvalid?: boolean; updateAfter?: boolean; lateRequire?: boolean;
  afterSend?: () => Promise<void> } = {}) {
  let snapshot: StoredRow | undefined, delivery: DeliveryRef | undefined;
  const outcome = await invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds: { maxRows: 10, maxWork: 1000 } });
    await session.stage({ op: 'create', model: MODEL, id: ID, data: { title: 'Run', request: null,
      author: encodeValue('user', makeUserRef(w.subject.user_id)), stop_requested: options.stop ?? false } }, { cause: 'scenario' });
    const current = await session.read(MODEL, ID); assert.ok(current); snapshot = structuredClone(current);
    let lexical: unknown = current;
    if (options.invalid === 'copy') lexical = structuredClone(current);
    if (options.invalid === 'bare') lexical = { id: ID };
    if (options.invalid === 'stale') await session.stage({ op: 'update', model: MODEL, id: ID,
      data: { title: 'New stage' } }, { cause: 'scenario' });
    if (options.invalid === 'foreign') {
      await session.stage({ op: 'create', model: OTHER_MODEL, id: asId('other'), data: { title: 'Other' } }, { cause: 'scenario' });
      lexical = await session.read(OTHER_MODEL, asId('other')); assert.ok(lexical);
    }
    const send = () => {
      w.modelAccess.sendAttempts++;
      return stageScenarioReceiptSend(call, w.store, { source: TARGET, request: request(),
        when: { rule, inputs: { run: lexical, enabled: true } } });
    };
    if (options.catchInvalid) {
      await assert.rejects(send(), error => error instanceof StateError || error instanceof SchemaError);
      selectScenarioReceiptReturn(call, w.store, 'done');
      return { ...await session.finalize(), result: null, outbox: [] } as ExecutionEffects;
    }
    delivery = await send(); assert.ok(delivery);
    if (options.updateAfter) await session.stage({ op: 'update', model: MODEL, id: ID,
      data: { title: 'Later parent update', stop_requested: true } }, { cause: 'scenario' });
    await session.stage({ op: 'update', model: MODEL, id: ID,
      data: { request: encodeValue(`delivery(${TARGET})`, delivery) } }, { cause: 'scenario' });
    const row = await session.read(MODEL, ID); assert.ok(row);
    await stageScenarioReceiptDelivery(call, w.store, { model: MODEL, row, field: 'request' });
    await options.afterSend?.();
    if (options.lateRequire) throw new StateError('forbidden', 'Parent rejected after model SEND.');
    selectScenarioReceiptReturn(call, w.store, 'done');
    const effects = await session.finalize(); return { ...effects, result: null, outbox: effects.outbox ?? [] } as ExecutionEffects;
  } });
  return { outcome, snapshot, delivery };
}

test('model SEND retains its original row snapshot after later parent updates and replay performs no guard or Work allocation', async () => {
  const w = await world('model'), result = await runModel(w, { updateAfter: true });
  assert.equal(result.outcome.status, 'committed'); assert.ok(result.snapshot); assert.ok(result.delivery);
  const saved = await effects(w); assert.equal(saved.dispatch.length, 1); assert.equal(saved.outbox.length, 1);
  assert.equal(saved.rows[0]!.data.stop_requested, true); assert.equal(saved.rows[0]!.data.title, 'Later parent update');
  const persisted = readDispatchSourceGuard(saved.dispatch[0]!.data); assert.ok(persisted);
  assert.deepEqual(persisted.inputs, { run: result.snapshot, enabled: true });
  assert.equal(readDispatchRow(saved.dispatch[0]!).filePayloadOrigin?.origin.kind, 'send-guard');
  assert.ok(w.guardSnapshots.length > 0);
  for (const captured of w.guardSnapshots) assert.deepEqual(captured, result.snapshot);
  const calls = w.calls, stages = w.stages;
  assert.equal((await runModel(w)).outcome.status, 'replayed');
  assert.equal(w.calls, calls); assert.equal(w.stages, stages); assert.deepEqual(await effects(w), saved);
});

test('false model source guard records a skipped receipt with no Work dispatch or provider intent', async () => {
  const w = await world('model'), result = await runModel(w, { stop: true });
  assert.equal(result.outcome.status, 'committed'); assert.ok(result.delivery); assert.equal(w.stages, 0);
  const saved = await effects(w); assert.equal(saved.rows.length, 1); assert.deepEqual(saved.dispatch, []); assert.deepEqual(saved.outbox, []);
  assert.equal(saved.receipts.length, 1); assert.equal(saved.associations.length, 1);
  const retained = readReceiptRow(saved.receipts[0]!);
  assert.equal(retained.receipt.status, 'skipped'); assert.equal(retained.receipt.deliveryId, result.delivery.id);
  assert.equal(retained.filePayloadOrigin?.origin.kind, 'delivery-skipped');
  if (retained.filePayloadOrigin?.origin.kind !== 'delivery-skipped') assert.fail('Actual source-skipped origin required.');
  assert.deepEqual(retained.filePayloadOrigin.origin.guard, modelGuard);
});

test('model SEND refuses copied, stale, foreign and bare reference inputs even when the owner catches the refusal', async () => {
  for (const invalid of ['copy', 'stale', 'foreign', 'bare'] as const) {
    const w = await world('model');
    await assert.rejects(runModel(w, { invalid, catchInvalid: true }), error => error instanceof StateError || error instanceof SchemaError);
    assert.equal(w.modelAccess.sendAttempts, 1, `${invalid} must reach the genuine SEND boundary`);
    assert.equal(w.calls, 0, `${invalid} must refuse before the literal evaluator`);
    assert.equal(w.stages, 0); assert.equal(w.receiptPreparations, 0);
    assert.deepEqual(await effects(w), { rows: [], dispatch: [], receipts: [], associations: [], outbox: [] });
    assert.deepEqual(await w.store.query({ model: OTHER_MODEL, authority: 'owner' }), []);
  }
});

test('model SEND current source grant and tracked author membership fence capture and commit', async () => {
  for (const loss of ['capture-grant', 'capture-subject', 'commit-grant', 'commit-subject'] as const) {
    const w = await world('model');
    const revoke = async () => {
      if (loss.endsWith('grant')) w.modelAccess.allowed = false;
      else await w.memberships.removeMembership(w.member!.membership_id);
    };
    if (loss.startsWith('capture')) await revoke();
    await assert.rejects(runModel(w, { updateAfter: true,
      ...(loss.startsWith('commit') ? { afterSend: revoke } : {}) }), error => error instanceof StateError && error.code === 'forbidden');
    assert.deepEqual(await effects(w), { rows: [], dispatch: [], receipts: [], associations: [], outbox: [] });
    if (loss.startsWith('capture')) assert.equal(w.stages, 0);
  }
});

test('later parent rejection rolls back model creation, frozen SEND snapshot and pending or skipped receipt effects', async () => {
  for (const verdict of [true, false]) {
    const w = await world('model', verdict);
    await assert.rejects(runModel(w, { updateAfter: true, lateRequire: true }), error => error instanceof StateError && error.code === 'forbidden');
    assert.deepEqual(await effects(w), { rows: [], dispatch: [], receipts: [], associations: [], outbox: [] });
  }
});

function correlatedRequest(source: string, revision: string): BoundCapabilityRequest {
  return { ...request(), arguments: { value: { source, revision, prompt: 'Generate' } } };
}

test('one installed generation profile binds distinct actual request identities for pending/null and skipped receipts', async () => {
  for (const verdict of [true, false]) {
    const w = await world('plain', verdict, true, 'ordinary', 'generation-profile');
    const pairs = [{ source: 'profile-first', revision: '11' }, { source: 'profile-second', revision: '29' }];
    for (const [index, correlation] of pairs.entries()) {
      const result = await run(w, { recordId: `profile-run-${index}`, carrier: correlatedRequest(correlation.source, correlation.revision),
        envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), {}) });
      assert.equal(result.outcome.status, 'committed'); assert.ok(result.delivery);
      const row = await w.store.load(asModel(RECEIPT_MODEL), asId(result.delivery.id)); assert.ok(row);
      const retained = readReceiptRow(row);
      assert.equal(retained.receipt.status, verdict ? 'pending' : 'skipped'); assert.equal(retained.receipt.result, null);
      const origin = retained.filePayloadOrigin?.origin; assert.ok(origin);
      assert.equal(origin.kind, verdict ? 'delivery-result' : 'delivery-skipped');
      if (origin.kind !== 'delivery-result' && origin.kind !== 'delivery-skipped') assert.fail('Genuine delivery origin required.');
      assert.equal(origin.declaration.kind, 'generation');
      if (origin.declaration.kind !== 'generation') assert.fail('Runtime exact generation context required.');
      assert.deepEqual(origin.declaration.request, correlation); assert.deepEqual(origin.request, { binding: BINDING, from: FROM });
      assert.equal(origin.resultDeclarationId, 'guarded/provider/result');
      assert.deepEqual(origin.association, { model: MODEL, recordId: `profile-run-${index}`, field: 'request' });
    }
    const saved = await effects(w); assert.equal(saved.rows.length, 2); assert.equal(saved.receipts.length, 2);
    assert.equal(saved.dispatch.length, verdict ? 2 : 0); assert.equal(saved.outbox.length, verdict ? 2 : 0);
    if (!verdict) assert.equal(w.stages, 0);
  }
});

test('static generation profile refuses mismatched runtime request, source, revision, ID, binding, from, scope and declaration before null acceptance', async () => {
  for (const verdict of [true, false]) for (const mismatch of ['request', 'source', 'revision', 'id', 'binding', 'from', 'scope', 'declaration'] as const) {
    const w = await world('plain', verdict, true, 'ordinary', 'generation-profile');
    if (mismatch === 'scope') w.receiptScope = { app: APP, owner: 'foreign-team', ownerPackage: 'Guarded' };
    else w.receiptOriginMutation = origin => {
      assert.ok(origin.kind === 'delivery-result' || origin.kind === 'delivery-skipped');
      if (origin.kind !== 'delivery-result' && origin.kind !== 'delivery-skipped') assert.fail('Actual delivery origin required.');
      assert.equal(origin.declaration.kind, 'generation');
      if (origin.declaration.kind !== 'generation') assert.fail('Actual generation context required.');
      if (mismatch === 'id') return { ...origin, deliveryId: 'foreign-delivery' };
      if (mismatch === 'binding') return { ...origin, request: { ...origin.request, binding: 'foreign-binding' } };
      if (mismatch === 'from') return { ...origin, request: { ...origin.request, from: 'foreign-install' } };
      if (mismatch === 'declaration') return { ...origin, resultDeclarationId: 'guarded/missing/result' };
      return { ...origin, declaration: { ...origin.declaration, request: mismatch === 'request'
        ? { source: '', revision: '' } : { source: mismatch === 'source' ? 'foreign-source' : origin.declaration.request.source,
          revision: mismatch === 'revision' ? '99' : origin.declaration.request.revision } } };
    };
    await assert.rejects(run(w, { carrier: correlatedRequest('profile-real', '17') }));
    assert.equal(w.receiptPreparations, 1, `${mismatch} must reach actual receipt origin preparation`);
    assert.deepEqual(await effects(w), { rows: [], dispatch: [], receipts: [], associations: [], outbox: [] });
  }
});

test('generation profile retained receipt progress preserves the original header and rich result request correspondence', async () => {
  const w = await world('plain', true, true, 'ordinary', 'generation-profile');
  const correlation = { source: 'profile-rich', revision: '41' };
  const result = await run(w, { carrier: correlatedRequest(correlation.source, correlation.revision) }); assert.ok(result.delivery);
  const saved = await effects(w), row = saved.receipts[0]!, association = saved.associations[0]!;
  const retained = readReceiptRow(row), header = retained.filePayloadOrigin; assert.ok(header);
  assert.equal(header.origin.kind, 'delivery-result');
  if (header.origin.kind !== 'delivery-result' || header.origin.declaration.kind !== 'generation') assert.fail('Original generation result origin required.');
  const context = { source: TARGET, declaredResult: header.origin.declaration.canonical.result, request: correlation };
  const revision = await w.store.readRevision(), meta = { nowMs: FIXED_NOW, actor: w.actor.user.user_id };
  const rich = { ...correlation, sequence: '1', state: 'succeeded', content: 'Generated', used_tokens: null, detail: null };
  const data = { ...retained.receipt, revision: revision + 1, status: 'succeeded' as const,
    result: rich, contentRef: null, resultExpiresAtMs: null };
  for (const wrong of [{ ...rich, source: 'foreign-source' }, { ...rich, revision: '99' }]) {
    assert.throws(() => withReceiptRowData(row, { ...data, result: wrong }, meta, context), /inconsistent/);
  }
  const next = withReceiptRowData(row, data, meta, context);
  assert.deepEqual(readReceiptRow(next, context).filePayloadOrigin, header);
  const link = readAssociationRow(association);
  const nextAssociation = withAssociationRowData(association, { recordModel: MODEL, recordId: ID, field: 'request',
    deliveryId: link.deliveryId!, source: link.source, revision: revision + 1 }, meta);
  await w.store.commit(makeBatch(revision, { writes: [
    { kind: 'update', model: asModel(RECEIPT_MODEL), id: row.id, expectedVersion: row.version, row: next },
    { kind: 'update', model: asModel(RECEIPT_ASSOCIATION_MODEL), id: association.id, expectedVersion: association.version, row: nextAssociation },
  ] }));
  const current = await w.store.load(asModel(RECEIPT_MODEL), row.id); assert.ok(current);
  assert.deepEqual(readReceiptRow(current, context).receipt.result, rich);
  assert.deepEqual(readReceiptRow(current, context).filePayloadOrigin, header);
});
