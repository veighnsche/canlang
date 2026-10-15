/** Work-backed child SEND controls relocated from State9c5169d9.
 * State engine-only owner-call controls remain under its own runner.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoundCapabilityRequest, CanTypeId, ClosedInputs, DeliveryRef, FileReferenceInventory, Receipt, Revision, StoredRow } from '@canlang/contracts';
import { encodeValue, SchemaError } from '@canlang/values';
import { createFrozenClock, createMemoryIdentityStore as createOwningIdentityStore } from '@canlang/identity/testing';
import { stageCanonicalSend, readCanonicalSendStaging } from '@canlang/work/kernel/dispatch-staging';
import { WORK_DISPATCH_MODEL, readDispatchRow } from '@canlang/work/kernel/tables';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work';
import { STATE_FILE_REFERENCE_PRODUCER, prepareFrameworkFilePayloadOrigin, createTestMemoryStorage } from '@canlang/state/storage';
import { StateError } from '@canlang/state/errors';
import { buildModelTableFromCanonical } from '@canlang/state/mutation/models';
import type { OwnerMutationSession } from '@canlang/state/mutation/pipeline';
import { buildPolicyTable } from '@canlang/state/policy/grants';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '@canlang/state/invocation/registry';
import { invoke, type ExecutionEffects, beginScenarioReceiptMutation, bindScenarioReceiptCallProducer,
  invokeScenarioReceiptCall, selectScenarioReceiptReturn, readScenarioReceiptAssociation, projectScenarioReceipt,
  bindScenarioReceiptFrameworkProducer, stageScenarioReceiptSend, stageScenarioReceiptDelivery,
  type ScenarioReceiptFrameworkProducer } from '@canlang/state/invocation';
import type { AdmittedCall } from '@canlang/state/invocation/admission';
import { RECEIPT_MODEL, RECEIPT_ASSOCIATION_MODEL, readReceiptRow } from '@canlang/state/receipt/tables';
import { FIXED_NOW, asModel, makeEnvelope, makeIdentity, seedRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';

const MODEL = asModel('Calls.Task'), ROOT = 'Calls.approve', UPDATE = `${MODEL}.update`, COMPLETE = 'Calls.complete';
const APP = 'owner-call-app', bounds = { maxRows: 10, maxWork: 1000 }, cause = { cause: 'scenario' } as const;
let sequence = 70_000;
const source = () => ({ path: 'calls.can', sha256: 'd'.repeat(64), module: 'calls.mjs' });
function artifact(scalarChild = false, childIntrinsic = false): ArtifactDescriptorSlice {
  const disclosure = (id: string) => ({ version: 1 as const, source: source(), returns: [
    { id, source: source(), influences: [], dependencies: [] },
  ] });
  return { artifact_version: 1, sources: [{ path: 'calls.can', sha256: 'd'.repeat(64) }],
    modules: [{ path: 'calls.mjs', js: 'export const identity="Calls.approve";', map: {
      version: 3, file: 'calls.mjs', sources: ['calls.can'], sourcesContent: [null], names: [], mappings: '',
    } }],
    callables: [ROOT, COMPLETE].map(id => ({ id, kind: 'operation' as const,
      module: 'calls.mjs', export: 'identity', member: [id.split('.').at(-1)!] })),
    models: [{ name: MODEL, deleteMode: 'archive', fields: [
      { name: 'key', field: { kind: 'string' }, required: true, serverOnly: false },
      { name: 'done', field: { kind: 'boolean' }, required: false, serverOnly: false },
      { name: 'approved', field: { kind: 'boolean' }, required: false, serverOnly: false },
    ] }],
    operations: [
      { name: ROOT, kind: 'scenario', description: '', inputs: { fields: [] },
        result: { type: 'void' as CanTypeId, disclosure: disclosure('root-return') } },
      { name: UPDATE, kind: 'update', description: '', inputs: { fields: [
        { name: 'record', field: { kind: 'ref', model: MODEL, requireVersion: true }, required: true },
        { name: 'key', field: { kind: 'string' }, required: false },
        { name: 'done', field: { kind: 'boolean' }, required: false },
      ] } },
      { name: COMPLETE, kind: 'scenario', description: '', inputs: { fields: [
        { name: 'task', field: { kind: 'ref', model: MODEL, requireVersion: true }, required: true },
      ] }, result: { type: (scalarChild ? 'text' : 'void') as CanTypeId, disclosure: scalarChild ? {
        version: 1, source: source(), returns: [{ id: 'complete-return', source: source(), influences: [], dependencies: [
          { id: 'child-key', source: source(), role: 'data', model: MODEL, field: 'key', type: 'text' as CanTypeId },
        ], ...(childIntrinsic ? { intrinsics: [{ id: 'child-version', source: source(), role: 'data' as const,
          kind: 'admitted-reference-version' as const, parameter: 'task', model: MODEL, type: 'int' as CanTypeId }] } : {}) }],
      } : disclosure('complete-return') } },
    ],
  };
}
const stateError = (error: unknown) => error instanceof StateError;
const empty = (): ExecutionEffects => ({ result: null, writes: [], history: [], outbox: [], schedules: [],
  uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {} });

// Same checked parent/child admission, with the real Identity SDK and Work
// one-shot producer. These controls qualify State staging, not native source.
const childSource = { path: 'child.can', sha256: 'f'.repeat(64), module: 'child.mjs' };
const SEND_TARGET = 'std.TextGenerationV1.generate', CHILD_BINDING = 'Calls.ChildWriter', ROOT_BINDING = 'Calls.RootWriter';
const childSendRule = `${COMPLETE}.send.0`;
async function frameworkWorld(boundChild = true, childApp = APP, guarded = false) {
  const original = artifact();
  const child = original.operations!.find(operation => operation.name === COMPLETE)!;
  original.operations![original.operations!.indexOf(child)] = { ...child, result: { ...child.result!,
    disclosure: { version: 1, source: childSource,
      returns: [{ id: 'complete-return', source: childSource, dependencies: [], influences: [] }] } } };
  original.sources!.push({ path: childSource.path, sha256: childSource.sha256 });
  original.modules!.push({ path: childSource.module, js: 'export const identity="Calls.complete";', map: {
    version: 3, file: childSource.module, sources: [childSource.path], sourcesContent: [null], names: [], mappings: '',
  } });
  original.callables!.find(callable => callable.id === COMPLETE)!.module = childSource.module;
  original.models![0]!.fields.push({ name: 'request', required: false, nullable: true, serverOnly: false,
    field: { kind: 'delivery', capability: 'std.TextGenerationV1', operation: 'generate', version: 1, result: { name: 'TextRun', fields: [
      { name: 'source', type: 'text' as CanTypeId }, { name: 'revision', type: 'int' as CanTypeId },
      { name: 'sequence', type: 'int' as CanTypeId },
      { name: 'state', type: 'enum(queued,running,succeeded,failed,unknown,cancelled)' as CanTypeId },
      { name: 'content', type: 'text' as CanTypeId }, { name: 'used_tokens', type: 'int?' as CanTypeId },
      { name: 'detail', type: 'text?' as CanTypeId },
    ] } } });
  const requestField = original.models![0]!.fields.at(-1)!;
  assert.ok(requestField.field.kind === 'delivery' && requestField.field.result !== undefined);
  if (guarded) original.valueTypes = { contracts: [requestField.field.result] };
  const loaded = loadArtifactDescriptors(original, { by: def => def.name === COMPLETE ? { role: 'Calls.worker' } : 'members' });
  const parent = loaded.registry.get(ROOT)!, complete = loaded.registry.get(COMPLETE)!;
  assert.ok(isGeneratedOperationDef(parent) && isGeneratedOperationDef(complete));
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields, containment: loaded.containment });
  const memberships = createOwningIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const user = await memberships.createUser({ email: 'child-send@example.test', password_hash: 'test', email_verified: true });
  const member = await memberships.createMembership({ team_id: team.team_id, user_id: user.user_id,
    is_owner: false, roles: [{ role: 'Calls.worker', granted_at: new Date(FIXED_NOW).toISOString(), granted_by: user.user_id }] as
      Parameters<typeof memberships.createMembership>[0]['roles'] });
  const identity = makeIdentity({ userId: user.user_id, team, membership: member });
  const sendGuard = { rule: childSendRule, source: childSource, owner: COMPLETE,
    node: { start: 10, end: 20 }, binding: CHILD_BINDING, target: SEND_TARGET, inputs: [{ name: 'enabled', type: 'bool' as CanTypeId }] };
  const authority = { app: APP, stateOwner: 'Calls', stateStoreId: 'calls-state', fileStoreId: 'calls-files',
    receiver: { app: APP, team: team.team_id, owner: team.team_id } };
  const producers = [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER];
  const guardedStorage = guarded ? createTestMemoryStorage(authority, producers) : undefined;
  const { store, probe } = guardedStorage ?? createTestMemoryStorage();
  const snapshot = { owner: authority.stateOwner, snapshotId: 'calls-original', digest: 'calls-source',
    installedAt: FIXED_NOW, installedRevision: 1 as Revision };
  if (guardedStorage !== undefined) {
    const inventoryIdentity = { owner: snapshot.owner, snapshotId: snapshot.snapshotId, digest: snapshot.digest };
    const inventory: FileReferenceInventory = { ...inventoryIdentity, canonicalModels: loaded.models, artifactModels: original.models!,
      valueTypes: loaded.valueTypes!, frameworkModels: producers.flatMap(producer => producer.models), opaqueDeclarationSets: [{
        id: 'calls-child-original', inventory: inventoryIdentity, snapshot, sources: original.sources!,
        canonicalModels: loaded.models, artifactModels: original.models!, valueTypes: loaded.valueTypes!,
        originalContracts: { TextRun: { fields: Object.fromEntries(requestField.field.result.fields.map(field => [field.name, { type: field.type }])) } },
        valueDefaults: [], declarations: [{ id: 'child-lexical', source: { kind: 'send-guard', ...sendGuard },
          profile: { kind: 'inputs', canonical: [{ name: 'enabled', kind: 'boolean', valueType: 'bool' as CanTypeId, required: true }],
            artifact: [{ name: 'enabled', field: { kind: 'boolean' }, valueType: 'bool' as CanTypeId, required: true }] } }],
      }] };
    await guardedStorage.store.installFileReferenceInventory({ expectedRevision: await store.readRevision(), authority, snapshot, inventory });
  }
  const row = await seedRow(store, MODEL, { data: { key: 'original', done: false, approved: false, request: null } });
  const stages: Array<{ call: string; ordinal: number; operationId: string }> = [];
  let duringStage: (() => Promise<void>) | undefined, duringGuard: (() => Promise<void>) | undefined, guards = 0;
  const producer = (owner: string, binding: string, origin: ReturnType<typeof source>): ScenarioReceiptFrameworkProducer => ({
    source: origin, app: owner === COMPLETE ? childApp : APP,
    bindings: [{ binding, from: `${binding}.installed`, targets: [{ source: SEND_TARGET, correlation: 'value' }] }],
    stage: async (input, context) => {
      stages.push({ call: context.operation, ordinal: input.occurrenceIndex, operationId: input.operationId });
      await duringStage?.(); return stageCanonicalSend(input, context, input.sourceGuard === undefined || guardedStorage === undefined ? undefined : {
        prepareSourceGuardOrigin: async (row, intent) => prepareFrameworkFilePayloadOrigin(guardedStorage.store, {
          expectedRevision: await store.readRevision(), inventoryOwner: snapshot.owner, declarationSetId: 'calls-child-original',
          model: WORK_DISPATCH_MODEL, row, field: 'sourceGuard', scope: { app: APP, ownerPackage: 'Calls', owner: team.team_id }, files: [],
          origin: { kind: 'send-guard', declaration: sendGuard, inputsDeclarationId: 'child-lexical', intent: {
            intentId: intent.intentId, operation: intent.operation, operationId: intent.operationId, target: intent.target,
            occurrenceIndex: intent.occurrenceIndex, dispatchGuard: childSendRule } },
        }),
      });
    }, read: readCanonicalSendStaging,
    ...(owner !== COMPLETE ? {} : { sendGuards: [sendGuard],
      evaluateGuard: async ({ call, inputs }) => { guards++; assert.equal(call.def, complete); assert.ok(Object.isFrozen(inputs));
        await duringGuard?.(); return inputs.enabled === true; } }),
  });
  bindScenarioReceiptFrameworkProducer(parent, producer(ROOT, ROOT_BINDING, source()));
  if (boundChild) bindScenarioReceiptFrameworkProducer(complete, producer(COMPLETE, CHILD_BINDING, childSource));
  const policy = buildPolicyTable([{ model: MODEL, secretFields: [], grants: [{ by: 'members', fields: ['key', 'done', 'approved'] }] }]);
  return { store, probe, memberships, member, identity, table, row, parent, complete, stages, policy,
    registry: loaded.registry, app: APP, source: 'checked child framework', clock: { nowMs: () => FIXED_NOW },
    envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), {}),
    get guards() { return guards; }, set duringStage(value: (() => Promise<void>) | undefined) { duringStage = value; },
    set duringGuard(value: (() => Promise<void>) | undefined) { duringGuard = value; },
  };
}
type FrameworkWorld = Awaited<ReturnType<typeof frameworkWorld>>;
const frameworkRequest = (binding = CHILD_BINDING): BoundCapabilityRequest => ({ binding, from: `${binding}.installed`,
  arguments: { value: { source: 'actual-request', revision: '7', prompt: 'Generate' } } });
const childInputs = (w: FrameworkWorld) => ({ task: { id: w.row.id, version: String(w.row.version) } });
function bindFrameworkChild(w: FrameworkWorld,
  execute: (frame: Parameters<Parameters<typeof bindScenarioReceiptCallProducer>[1]['execute']>[0]) => Promise<unknown>) {
  bindScenarioReceiptCallProducer(w.parent, { source: source(), app: APP, registry: w.registry,
    sites: [{ id: 'complete-site', source: source(), kind: 'operation', resultType: 'void' as CanTypeId,
      targets: [{ operation: COMPLETE, interface: w.complete.descriptor }] }],
    prepare: (_def, inputs) => inputs as ClosedInputs, execute });
}
async function frameworkSnapshot(w: FrameworkWorld) {
  return { row: await w.store.load(MODEL, w.row.id), history: await w.store.historyFor(MODEL, w.row.id),
    dispatch: await w.store.query({ model: WORK_DISPATCH_MODEL, authority: 'owner', archived: 'include' }),
    receipts: await w.store.query({ model: asModel(RECEIPT_MODEL), authority: 'owner', archived: 'include' }),
    associations: await w.store.query({ model: asModel(RECEIPT_ASSOCIATION_MODEL), authority: 'owner', archived: 'include' }),
    outbox: w.probe.outboxAll() };
}
async function finishFramework(call: AdmittedCall, w: FrameworkWorld, session: OwnerMutationSession) {
  selectScenarioReceiptReturn(call, w.store, 'root-return');
  const output = await session.finalize();
  return { ...output, result: null, outbox: ('outbox' in output ? output.outbox : []) ?? [] } as ExecutionEffects;
}

test('child framework SEND uses its own source producer, shared ordered ledger, receipt and replay', async () => {
  const w = await frameworkWorld(); let childCall: AdmittedCall | undefined, childRuns = 0, roots = 0, receipt: Receipt | undefined, commits = 0;
  const commit = w.store.commit; w.store.commit = async batch => { commits++; return commit(batch); };
  const revision = await w.store.readRevision();
  bindFrameworkChild(w, async frame => {
    childRuns++; childCall = frame.call;
    const delivery = await stageScenarioReceiptSend(frame.call, w.store, { source: SEND_TARGET, request: frameworkRequest() });
    await frame.session.stage({ op: 'update', model: MODEL, id: w.row.id,
      data: { done: true, request: encodeValue(`delivery(${SEND_TARGET})`, delivery) } }, cause);
    const row = await frame.session.read(MODEL, w.row.id); assert.ok(row);
    await stageScenarioReceiptDelivery(frame.call, w.store, { model: MODEL, row, field: 'request' });
    assert.equal((await w.store.load(MODEL, w.row.id))!.data.done, false);
    assert.equal((await frameworkSnapshot(w)).dispatch.length, 0);
    selectScenarioReceiptReturn(frame.call, w.store, 'complete-return'); return null;
  });
  const input = { ...w, execute: async (call: AdmittedCall) => {
    roots++; const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds: { maxRows: 30, maxWork: 1000 } });
    await stageScenarioReceiptSend(call, w.store, { source: SEND_TARGET, request: frameworkRequest(ROOT_BINDING) });
    await invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE, inputs: childInputs(w) });
    await stageScenarioReceiptSend(call, w.store, { source: SEND_TARGET, request: frameworkRequest(ROOT_BINDING) });
    return finishFramework(call, w, session);
  }, observeCommittedReceipt: (saved: Receipt) => { receipt = saved; } };
  assert.equal((await invoke(input)).status, 'committed'); assert.ok(receipt && childCall);
  assert.equal(commits, 1); assert.equal(await w.store.readRevision(), revision + 1);
  assert.deepEqual(w.stages.map(stage => [stage.call, stage.ordinal]), [[ROOT, 0], [COMPLETE, 1], [ROOT, 2]]);
  assert.ok(w.stages.every(stage => stage.operationId === childCall!.context.operationId));
  const saved = await frameworkSnapshot(w);
  assert.deepEqual([...saved.outbox].sort((left, right) => left.occurrenceIndex! - right.occurrenceIndex!)
    .map(intent => [intent.operation, intent.occurrenceIndex, intent.arguments.binding]),
    [[ROOT, 0, ROOT_BINDING], [COMPLETE, 1, CHILD_BINDING], [ROOT, 2, ROOT_BINDING]]);
  assert.deepEqual(saved.dispatch.map(row => readDispatchRow(row).occurrenceIndex).sort(), [0, 1, 2]);
  assert.equal(saved.receipts.length, 1); assert.equal(readReceiptRow(saved.receipts[0]!).receipt.status, 'pending');
  const association = readScenarioReceiptAssociation(receipt);
  assert.equal(association!.calls![0]!.target, COMPLETE); assert.deepEqual(association!.calls![0]!.scenario!.plan.source, childSource);
  assert.equal(saved.history[0]!.operation, COMPLETE);
  const retained = structuredClone(receipt);
  assert.equal((await invoke(input)).status, 'replayed');
  assert.deepEqual(receipt, retained); assert.deepEqual(await frameworkSnapshot(w), saved);
  assert.equal(roots, 1); assert.equal(childRuns, 1); assert.equal(commits, 1);
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).records.map(record => record.id), [w.row.id]);
  await assert.rejects(stageScenarioReceiptSend(childCall, w.store, { source: SEND_TARGET, request: frameworkRequest() }), stateError);
  assert.deepEqual(await frameworkSnapshot(w), saved);
});

test('child framework false guard stages only its genuine skipped receipt at the shared ordinal', async () => {
  const w = await frameworkWorld(); let skipped: DeliveryRef | undefined;
  bindFrameworkChild(w, async frame => {
    skipped = await stageScenarioReceiptSend(frame.call, w.store, { source: SEND_TARGET, request: frameworkRequest(),
      when: { rule: childSendRule, inputs: { enabled: false } } });
    await frame.session.stage({ op: 'update', model: MODEL, id: w.row.id,
      data: { request: encodeValue(`delivery(${SEND_TARGET})`, skipped) } }, cause);
    const row = await frame.session.read(MODEL, w.row.id); assert.ok(row);
    await stageScenarioReceiptDelivery(frame.call, w.store, { model: MODEL, row, field: 'request' });
    selectScenarioReceiptReturn(frame.call, w.store, 'complete-return'); return null;
  });
  assert.equal((await invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE, inputs: childInputs(w) });
    await stageScenarioReceiptSend(call, w.store, { source: SEND_TARGET, request: frameworkRequest(ROOT_BINDING) });
    return finishFramework(call, w, session);
  } })).status, 'committed');
  const saved = await frameworkSnapshot(w); assert.ok(skipped);
  assert.equal(w.guards, 1); assert.deepEqual(w.stages.map(stage => [stage.call, stage.ordinal]), [[ROOT, 1]]);
  assert.equal(saved.outbox.length, 1); assert.equal(saved.dispatch.length, 1);
  assert.equal(saved.receipts.length, 1); assert.equal(saved.receipts[0]!.id, skipped.id);
  assert.equal(readReceiptRow(saved.receipts[0]!).receipt.status, 'skipped');
});

test('child framework true guard retains the actual child source declaration in real Work staging', async () => {
  const w = await frameworkWorld(true, APP, true);
  bindFrameworkChild(w, async frame => {
    await stageScenarioReceiptSend(frame.call, w.store, { source: SEND_TARGET, request: frameworkRequest(),
      when: { rule: childSendRule, inputs: { enabled: true } } });
    selectScenarioReceiptReturn(frame.call, w.store, 'complete-return'); return null;
  });
  assert.equal((await invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE, inputs: childInputs(w) });
    return finishFramework(call, w, session);
  } })).status, 'committed');
  const saved = await frameworkSnapshot(w);
  assert.equal(w.guards, 1); assert.equal(saved.dispatch.length, 1); assert.equal(saved.outbox.length, 1);
  const dispatch = readDispatchRow(saved.dispatch[0]!);
  assert.deepEqual(dispatch.sourceGuard!.source, childSource); assert.equal(dispatch.sourceGuard!.owner, COMPLETE);
  assert.equal(dispatch.sourceGuard!.rule, childSendRule); assert.equal(dispatch.guardVerdict, true);
  assert.equal(saved.outbox[0]!.operation, COMPLETE); assert.equal(saved.outbox[0]!.dispatchGuard, childSendRule);
  assert.equal(dispatch.filePayloadOrigin!.origin.kind, 'send-guard');
});

test('nested child framework SEND follows the admitted parent chain without borrowing the outer call', async () => {
  const w = await frameworkWorld(); let nested: AdmittedCall | undefined;
  bindScenarioReceiptCallProducer(w.complete, { source: childSource, app: APP, registry: w.registry,
    sites: [{ id: 'nested-root', source: childSource, kind: 'operation', resultType: 'void' as CanTypeId,
      targets: [{ operation: ROOT, interface: w.parent.descriptor }] }], prepare: (_def, inputs) => inputs as ClosedInputs,
    execute: async frame => {
      nested = frame.call;
      assert.equal(frame.parent.def, w.complete); assert.notEqual(frame.parent, frame.call);
      await stageScenarioReceiptSend(frame.call, w.store, { source: SEND_TARGET, request: frameworkRequest(ROOT_BINDING) });
      selectScenarioReceiptReturn(frame.call, w.store, 'root-return'); return null;
    } });
  bindFrameworkChild(w, async frame => {
    await stageScenarioReceiptSend(frame.call, w.store, { source: SEND_TARGET, request: frameworkRequest() });
    await invokeScenarioReceiptCall(frame.call, w.store, { site: 'nested-root', target: ROOT, inputs: {} });
    await stageScenarioReceiptSend(frame.call, w.store, { source: SEND_TARGET, request: frameworkRequest() });
    selectScenarioReceiptReturn(frame.call, w.store, 'complete-return'); return null;
  });
  let outer: AdmittedCall | undefined, receipt: Receipt | undefined;
  assert.equal((await invoke({ ...w, execute: async call => {
    outer = call; const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE, inputs: childInputs(w) });
    return finishFramework(call, w, session);
  }, observeCommittedReceipt: saved => { receipt = saved; } })).status, 'committed');
  assert.ok(nested && outer && receipt); assert.notEqual(nested, outer); assert.equal(nested.def, outer.def);
  assert.deepEqual(w.stages.map(stage => [stage.call, stage.ordinal]), [[COMPLETE, 0], [ROOT, 1], [COMPLETE, 2]]);
  assert.deepEqual(readScenarioReceiptAssociation(receipt)!.calls!.map(call => [call.caller, call.target]), [[COMPLETE, ROOT], [ROOT, COMPLETE]]);
  assert.equal((await frameworkSnapshot(w)).outbox.length, 3);
});

test('child framework unbound, foreign app/store, copied call and wrong source routes poison the outer owner', async () => {
  for (const mode of ['unbound', 'app', 'store', 'copy', 'binding', 'from', 'target', 'guard', 'lexical', 'reentry', 'guard-throws', 'parent-reentry'] as const) {
    const w = await frameworkWorld(mode !== 'unbound', mode === 'app' ? 'foreign-app' : APP), before = await frameworkSnapshot(w);
    bindFrameworkChild(w, async frame => {
      if (mode === 'reentry') w.duringStage = async () => {
        await assert.rejects(stageScenarioReceiptSend(frame.call, w.store, { source: SEND_TARGET, request: frameworkRequest() }), stateError);
      };
      if (mode === 'guard-throws') w.duringGuard = async () => { throw new StateError('rule_failed', 'first evaluated child SEND guard'); };
      if (mode === 'parent-reentry') {
        await assert.rejects(stageScenarioReceiptSend(frame.parent, w.store, { source: SEND_TARGET, request: frameworkRequest(ROOT_BINDING) }), stateError);
      }
      const originalRequest = frameworkRequest(mode === 'binding' ? ROOT_BINDING : CHILD_BINDING);
      const request = mode === 'from' ? { ...originalRequest, from: 'foreign-install' } : originalRequest;
      await assert.rejects(stageScenarioReceiptSend(mode === 'copy' ? { ...frame.call } : frame.call,
        mode === 'store' ? { ...w.store } : w.store, { source: mode === 'target' ? 'foreign.target' : SEND_TARGET, request,
          ...(['guard', 'lexical', 'guard-throws'].includes(mode) ? { when: { rule: mode === 'guard' ? 'foreign-rule' : childSendRule,
            inputs: { enabled: mode === 'lexical' ? 'false' : false } } } : {}) }), mode === 'lexical' ? error => error instanceof SchemaError : stateError);
      selectScenarioReceiptReturn(frame.call, w.store, 'complete-return'); return null;
    });
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      await assert.rejects(invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE, inputs: childInputs(w) }), stateError);
      await assert.rejects(session.finalize(), stateError); return empty();
    } }), stateError, mode);
    assert.deepEqual(await frameworkSnapshot(w), before, mode);
    if (mode === 'guard-throws') { assert.equal(w.guards, 1); assert.equal(w.stages.length, 0); }
  }
  const w = await frameworkWorld(false);
  assert.throws(() => bindScenarioReceiptFrameworkProducer(w.complete, { source: source(), app: APP, bindings: [],
    stage: (input, context) => stageCanonicalSend(input, context), read: readCanonicalSendStaging }), stateError, 'parent source cannot bind the child producer');
});

test('child framework SEND and business writes roll back together on late failure or current child role revocation', async () => {
  for (const mode of ['late-require', 'revoked-role'] as const) {
    const w = await frameworkWorld(), before = await frameworkSnapshot(w), revision = await w.store.readRevision();
    bindFrameworkChild(w, async frame => {
      const delivery = await stageScenarioReceiptSend(frame.call, w.store, { source: SEND_TARGET, request: frameworkRequest() });
      await frame.session.stage({ op: 'update', model: MODEL, id: w.row.id,
        data: { done: true, request: encodeValue(`delivery(${SEND_TARGET})`, delivery) } }, cause);
      const row = await frame.session.read(MODEL, w.row.id); assert.ok(row);
      await stageScenarioReceiptDelivery(frame.call, w.store, { model: MODEL, row, field: 'request' });
      selectScenarioReceiptReturn(frame.call, w.store, 'complete-return'); return null;
    });
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      await invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE, inputs: childInputs(w) });
      if (mode === 'late-require') throw new StateError('rule_failed', 'late parent requirement');
      await w.memberships.setMembershipRoles(w.member.membership_id, []);
      return finishFramework(call, w, session);
    } }), stateError, mode);
    assert.deepEqual(await frameworkSnapshot(w), before, mode);
    assert.equal(await w.store.readRevision(), revision + (mode === 'late-require' ? 1 : 0),
      `${mode}: late business rejection receipts; current authority denial commits nothing`);
  }
});
