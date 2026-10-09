/** Defining State/Work join: checked descriptor fixtures, real admission,
 * owner mutation, Values, Work staging and Memory StoragePort. This does not
 * claim native Compiler source acceptance or a verified native loader. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoundCapabilityRequest, CanTypeId, CommitBatch, DeliveryRef, Receipt, StoragePort, StoredRow } from '@canlang/contracts';
import { encodeValue } from '@canlang/values';
import { StateError } from '@canlang/state/errors';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice, type GeneratedOperationDef } from '@canlang/state/invocation/registry';
import { buildModelTableFromCanonical } from '@canlang/state/mutation/models';
import { beginScenarioReceiptMutation, bindScenarioReceiptFrameworkProducer, invoke, invokeRetainedReceiptOnly, MAX_ADMISSION_ATTEMPTS,
  readScenarioReceiptAssociation, selectScenarioReceiptReturn, stageScenarioReceiptDelivery, stageScenarioReceiptSend,
  type AdmittedCall, type ExecutionEffects, type ScenarioReceiptMutationSession } from '@canlang/state/invocation';
import { associationRowId, RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL, readAssociationRow, readReceiptRow } from '@canlang/state/receipt/tables';
import { asId, asModel, FIXED_NOW, createMemoryIdentityStore, makeBatch, makeIdentity, makeEnvelope, seedMember,
  seedRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { stageCanonicalSend, readCanonicalSendStaging } from '@canlang/work/kernel/dispatch-staging';
import { WORK_DISPATCH_MODEL, readDispatchRow } from '@canlang/work/kernel/tables';

const MODEL = asModel('Joined.Record'), CREATED = asId('created'), OP = 'Joined.generate', APP = 'joined-framework';
const TARGET = 'std.TextGenerationV1.generate', BINDING = 'writer', FROM = 'deployment.writer';
const RECEIPTS = asModel(RECEIPT_MODEL), ASSOCIATIONS = asModel(RECEIPT_ASSOCIATION_MODEL);
const ASSOCIATION = asId(associationRowId(MODEL, CREATED, 'run'));
const bounds = { maxRows: 30, maxWork: 1000 }, cause = { cause: 'scenario' } as const;
const origin = { path: 'joined.can', sha256: 'e'.repeat(64), module: 'joined.mjs' };
let sequence = 65_000;
const validation = (error: unknown) => error instanceof StateError && error.code === 'validation';
const forbidden = (error: unknown) => error instanceof StateError && error.code === 'forbidden';

function artifact(): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: origin.path, sha256: origin.sha256 }],
    modules: [{ path: origin.module, js: 'export const identity="Joined.generate";',
      map: { version: 3, file: origin.module, sources: [origin.path], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: origin.module, export: 'identity', member: ['generate'], inputStyle: 'parameters' }],
    models: [{ name: MODEL, deleteMode: 'archive', uniqueKeys: ['title'], fields: [
      { name: 'title', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: true, serverOnly: false },
      { name: 'label', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: false, serverOnly: false,
        default: { kind: 'literal', value: 'model default' } },
      { name: 'token', field: { kind: 'secret' }, required: false, serverOnly: true,
        default: { kind: 'server', init: 'random_secret' } },
      // Original owning TextRun declaration from typed-generation-progress.json.
      { name: 'run', field: { kind: 'delivery', capability: 'std.TextGenerationV1', operation: 'generate', version: 1,
        result: { name: 'TextRun', fields: [
          { name: 'source', type: 'text' as CanTypeId }, { name: 'revision', type: 'int' as CanTypeId },
          { name: 'sequence', type: 'int' as CanTypeId },
          { name: 'state', type: 'enum(queued,running,succeeded,failed,unknown,cancelled)' as CanTypeId },
          { name: 'content', type: 'text' as CanTypeId }, { name: 'used_tokens', type: 'int?' as CanTypeId },
          { name: 'detail', type: 'text?' as CanTypeId },
        ] } },
        nullable: true, required: false, serverOnly: false },
    ] }],
    operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [
      { name: 'seed', field: { kind: 'ref', model: MODEL, requireVersion: true }, required: true },
      { name: 'note', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: false,
        default: { kind: 'literal', value: 'input default' } },
    ] }, result: { type: 'void' as CanTypeId, disclosure: { version: 1, source: origin,
      returns: [{ id: 'done', source: origin, dependencies: [], influences: [] }] } } }],
  };
}

async function world() {
  const { store: physical, probe } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore(), member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  const loaded = loadArtifactDescriptors(artifact(), { by: 'members' });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields, containment: loaded.containment,
    ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }) });
  bindScenarioReceiptFrameworkProducer(loaded.registry.get(OP)! as GeneratedOperationDef, {
    source: origin, app: APP, bindings: [{ binding: BINDING, from: FROM, targets: [{ source: TARGET, correlation: 'value' }] }],
    stage: stageCanonicalSend, read: readCanonicalSendStaging,
  });
  const seed = await seedRow(physical, MODEL, { id: 'seed', data: { title: 'seed', label: 'seed', token: 'seed secret', run: null } });
  const commits: CommitBatch[] = [];
  const store: StoragePort = { ...physical, commit: async batch => {
    commits.push(structuredClone(batch)); return physical.commit(batch);
  } };
  return { store, physical, probe, memberships, member, identity, table, seed, commits,
    registry: loaded.registry, app: APP, source: 'defining join fixture', clock: { nowMs: () => FIXED_NOW },
    envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), { seed: { id: seed.id, version: String(seed.version) } }) };
}
type World = Awaited<ReturnType<typeof world>>;
function request(revision = '7'): BoundCapabilityRequest {
  return { binding: BINDING, from: FROM, arguments: { value: { source: 'authored-request', revision, prompt: 'Draft a note' } } };
}
function send(call: AdmittedCall, w: World, carrier = request()) {
  return stageScenarioReceiptSend(call, w.store, { source: TARGET, request: carrier });
}
async function begin(call: AdmittedCall, w: World) {
  return beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
}
async function assign(call: AdmittedCall, w: World, session: ScenarioReceiptMutationSession,
  delivery: DeliveryRef | null, create = false): Promise<StoredRow> {
  await session.stage({ op: create ? 'create' : 'update', model: MODEL, id: CREATED,
    data: { ...(create ? { title: 'created' } : {}), run: encodeValue('delivery(std.TextGenerationV1.generate)?', delivery) } }, cause);
  const row = await session.views.final.get(MODEL, CREATED); assert.ok(row);
  await stageScenarioReceiptDelivery(call, w.store, { model: MODEL, row, field: 'run' });
  return row;
}
async function finish(call: AdmittedCall, w: World, session: ScenarioReceiptMutationSession): Promise<ExecutionEffects> {
  selectScenarioReceiptReturn(call, w.store, 'done');
  const output = await session.finalize();
  return { ...output, result: null, outbox: output.outbox ?? [] };
}
async function save(w: World) {
  let receipt: Receipt | undefined, active: AdmittedCall | undefined, row: StoredRow | undefined, delivery: DeliveryRef | undefined;
  const outcome = await invoke({ ...w, execute: async call => {
    active = call; const session = await begin(call, w); delivery = await send(call, w);
    row = await assign(call, w, session, delivery, true);
    assert.equal(await w.physical.load(MODEL, CREATED), null, 'owner staging has no physical domain effect');
    assert.equal(await w.physical.load(WORK_DISPATCH_MODEL, asId(delivery.id)), null, 'Work staging has no separate commit');
    assert.deepEqual(w.probe.outboxAll(), []);
    return finish(call, w, session);
  }, observeCommittedReceipt: value => { receipt = value; } });
  assert.ok(receipt); assert.ok(active); assert.ok(row); assert.ok(delivery);
  return { receipt, call: active, row, delivery, outcome };
}
async function snapshot(w: World) {
  return { domain: await w.physical.query({ model: MODEL, authority: 'owner', archived: 'include' }),
    dispatch: await w.physical.query({ model: WORK_DISPATCH_MODEL, authority: 'owner', archived: 'include' }),
    receipts: await w.physical.query({ model: RECEIPTS, authority: 'owner', archived: 'include' }),
    associations: await w.physical.query({ model: ASSOCIATIONS, authority: 'owner', archived: 'include' }),
    history: w.probe.historyFor(MODEL, CREATED), outbox: w.probe.outboxAll(),
    schedules: await w.physical.schedulesDue(FIXED_NOW, 30) };
}
async function assertRejected(w: World, before: Awaited<ReturnType<typeof snapshot>>, revision: number) {
  assert.deepEqual(await snapshot(w), before, 'all domain and framework effects are dropped together');
  assert.equal(await w.physical.readRevision(), revision + 1, 'only the fenced rejection receipt advances revision');
  const batch = w.commits.at(-1)!;
  assert.equal(batch.receipt?.outcome.status, 'rejected');
  for (const key of ['writes', 'history', 'outbox', 'schedules', 'uniqueClaims', 'uniqueReleases'] as const) assert.deepEqual(batch[key], []);
}

test('real Work send, authored receipt and association join one fenced owner commit with domain-only saved snapshots', async () => {
  const w = await world(), revision = await w.physical.readRevision();
  const saved = await save(w), batch = w.commits[0]!;
  assert.equal(saved.outcome.status, 'committed'); assert.equal(w.commits.length, 1);
  assert.equal(batch.expectedRevision, revision); assert.equal(await w.physical.readRevision(), revision + 1);
  assert.deepEqual(batch.writes.map(write => write.model).sort(), [MODEL, WORK_DISPATCH_MODEL, RECEIPTS, ASSOCIATIONS].sort());
  assert.equal(batch.history.length, 1); assert.equal(batch.uniqueClaims.length, 1); assert.equal(batch.outbox.length, 1);
  assert.equal(batch.outbox[0]!.intentId, saved.delivery.id); assert.deepEqual(batch.outbox[0]!.arguments, request());
  assert.equal(saved.receipt.resolvedDefaults['note'], 'input default');
  assert.equal(saved.receipt.resolvedDefaults[`0:${MODEL}.label`], 'model default');
  assert.equal(saved.receipt.resolvedDefaults[`0:${MODEL}.token`], saved.row.data['token']);
  const association = readScenarioReceiptAssociation(saved.receipt)!;
  assert.deepEqual(association.changed.map(change => change.model), [MODEL]);
  assert.deepEqual(association.changed[0]!.row, await w.physical.load(MODEL, CREATED));
  assert.ok(association.changed[0]!.withheldFields.includes('run'));
  const authored = await w.physical.load(RECEIPTS, asId(saved.delivery.id)); assert.ok(authored);
  assert.equal(readReceiptRow(authored).receipt.status, 'pending');
  const linked = await w.physical.load(ASSOCIATIONS, ASSOCIATION); assert.ok(linked);
  assert.equal(readAssociationRow(linked).deliveryId, saved.delivery.id);
});

test('ordinary and retained replay reuse the joined receipt without executing or committing', async () => {
  const w = await world(), saved = await save(w), before = await snapshot(w), revision = await w.physical.readRevision();
  let executions = 0, commits = 0;
  const store: StoragePort = { ...w.store, commit: async () => { commits++; throw new Error('replay commit'); } };
  const execute = async (): Promise<ExecutionEffects> => { executions++; throw new Error('replay execution'); };
  for (const retained of [false, true]) {
    const input = { ...w, store, execute, clock: { nowMs: () => FIXED_NOW + (retained ? 16 * 60_000 : 0) } };
    assert.equal((await (retained ? invokeRetainedReceiptOnly(input) : invoke(input))).status, 'replayed');
  }
  assert.equal(executions, 0); assert.equal(commits, 0); assert.equal(await w.physical.readRevision(), revision);
  assert.deepEqual(await snapshot(w), before); assert.deepEqual(await w.physical.readReceipt(saved.receipt.identity), saved.receipt);
});

test('same staged assignment twice then replacement or clear nets framework writes and retains both attempts', async () => {
  for (const clear of [false, true]) {
    const w = await world(); let attempts: DeliveryRef[] = [];
    await invoke({ ...w, execute: async call => {
      const session = await begin(call, w), first = await send(call, w); attempts.push(first);
      const row = await assign(call, w, session, first, true);
      await stageScenarioReceiptDelivery(call, w.store, { model: MODEL, row, field: 'run' });
      const second = await send(call, w, request('8')); attempts.push(second);
      await assign(call, w, session, second);
      if (clear) await assign(call, w, session, null);
      return finish(call, w, session);
    } });
    const batch = w.commits[0]!;
    assert.equal(w.commits.length, 1); assert.equal(batch.history.length, 1);
    assert.equal(batch.writes.filter(write => write.model === MODEL).length, 1);
    assert.equal(batch.writes.filter(write => write.model === RECEIPTS).length, 2);
    assert.equal(batch.writes.filter(write => write.model === ASSOCIATIONS).length, clear ? 0 : 1,
      'sequential insert/update/remove effects cannot reach pre-batch version guards');
    assert.deepEqual(batch.outbox.map(intent => intent.intentId), attempts.map(attempt => attempt.id));
    for (const attempt of attempts) {
      const row = await w.physical.load(RECEIPTS, asId(attempt.id)); assert.ok(row);
      assert.equal(readReceiptRow(row).receipt.status, 'pending', 'replacement preserves superseded attempt');
    }
    const current = await w.physical.load(ASSOCIATIONS, ASSOCIATION);
    if (clear) assert.equal(current, null);
    else { assert.ok(current); assert.equal(readAssociationRow(current).deliveryId, attempts[1]!.id); }
  }
});

test('existing association replacement and clear use original pre-batch version while preserving attempts', async () => {
  const w = await world(), first = await save(w);
  const previous = await w.physical.load(ASSOCIATIONS, ASSOCIATION); assert.ok(previous);
  const envelope = { ...w.envelope, operation_id: uuidv7(FIXED_NOW, ++sequence) };
  let second: DeliveryRef | undefined;
  await invoke({ ...w, envelope, execute: async call => {
    const session = await begin(call, w); second = await send(call, w, request('9'));
    await assign(call, w, session, second); await assign(call, w, session, null);
    return finish(call, w, session);
  } });
  const writes = w.commits[1]!.writes.filter(write => write.model === ASSOCIATIONS);
  assert.deepEqual(writes, [{ kind: 'remove', model: ASSOCIATIONS, id: previous.id, expectedVersion: previous.version }]);
  assert.equal(await w.physical.load(ASSOCIATIONS, ASSOCIATION), null);
  assert.ok(second);
  for (const attempt of [first.delivery, second]) assert.ok(await w.physical.load(RECEIPTS, asId(attempt.id)));
});

test('clearing and recreating an existing association preserves genuine creation metadata and storage order', async () => {
  const w = await world(), first = await save(w);
  const previous = await w.physical.load(ASSOCIATIONS, ASSOCIATION); assert.ok(previous);
  const envelope = { ...w.envelope, operation_id: uuidv7(FIXED_NOW, ++sequence) };
  let replacement: DeliveryRef | undefined;
  await invoke({ ...w, envelope, clock: { nowMs: () => FIXED_NOW + 1000 }, execute: async call => {
    const session = await begin(call, w);
    await assign(call, w, session, null);
    replacement = await send(call, w, request('10'));
    await assign(call, w, session, replacement);
    return finish(call, w, session);
  } });
  assert.ok(replacement);
  const writes = w.commits[1]!.writes.filter(write => write.model === ASSOCIATIONS);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], { kind: 'remove', model: ASSOCIATIONS, id: previous.id, expectedVersion: previous.version });
  assert.equal(writes[1]!.kind, 'insert');
  const current = await w.physical.load(ASSOCIATIONS, ASSOCIATION); assert.ok(current);
  assert.equal(current.created, FIXED_NOW + 1000); assert.equal(current.version, 1);
  assert.equal(readAssociationRow(current).deliveryId, replacement.id);
  for (const attempt of [first.delivery, replacement]) assert.ok(await w.physical.load(RECEIPTS, asId(attempt.id)));
});

test('tampering executor outbox, domain writes, defaults, history or unique claims rejects the whole joined transaction', async () => {
  for (const mode of ['outbox', 'domain', 'defaults', 'history', 'unique'] as const) {
    const w = await world(), before = await snapshot(w), revision = await w.physical.readRevision();
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await begin(call, w), delivery = await send(call, w);
      await assign(call, w, session, delivery, true);
      const output = structuredClone(await finish(call, w, session));
      if (mode === 'outbox') output.outbox = [];
      if (mode === 'domain') output.writes = output.writes.filter(write => write.model !== MODEL);
      if (mode === 'defaults') output.resolvedDefaults = {};
      if (mode === 'history') output.history = [];
      if (mode === 'unique') output.uniqueClaims = [];
      return output;
    } }), validation, mode);
    await assertRejected(w, before, revision);
  }
});

test('copied, foreign and stale owner rows, wrong routes and cross-store calls poison even caught failures', async () => {
  const foreignWorld = await world(), foreign = await save(foreignWorld);
  for (const mode of ['copied-row', 'foreign-row', 'stale-row', 'binding', 'from', 'store'] as const) {
    const w = await world(), before = await snapshot(w), revision = await w.physical.readRevision();
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await begin(call, w), delivery = await send(call, w);
      await session.stage({ op: 'create', model: MODEL, id: CREATED,
        data: { title: 'created', run: encodeValue('delivery(std.TextGenerationV1.generate)?', delivery) } }, cause);
      const row = await session.views.final.get(MODEL, CREATED); assert.ok(row);
      if (mode === 'stale-row') await session.stage({ op: 'update', model: MODEL, id: CREATED, data: { title: 'changed' } }, cause);
      const attempt = mode === 'binding' || mode === 'from'
        ? send(call, w, { ...request(), [mode === 'binding' ? 'binding' : 'from']: 'foreign' })
        : stageScenarioReceiptDelivery(call, mode === 'store' ? w.physical : w.store,
          { model: MODEL, row: mode === 'copied-row' ? structuredClone(row) : mode === 'foreign-row' ? foreign.row : row, field: 'run' });
      await assert.rejects(attempt, mode === 'store' ? forbidden : validation, mode);
      await assert.rejects(session.finalize(), validation, 'caught failure cannot restore the owner session');
      return { result: null, writes: [], history: [], outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {} };
    } }), validation, mode);
    await assertRejected(w, before, revision);
  }
});

test('framework stages refuse after finalization and after invocation closes', async () => {
  const w = await world(), before = await snapshot(w), revision = await w.physical.readRevision();
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await begin(call, w), delivery = await send(call, w);
    const row = await assign(call, w, session, delivery, true), output = await finish(call, w, session);
    await assert.rejects(send(call, w), validation);
    await assert.rejects(stageScenarioReceiptDelivery(call, w.store, { model: MODEL, row, field: 'run' }), validation);
    return output;
  } }), validation);
  await assertRejected(w, before, revision);
  const closedWorld = await world(), saved = await save(closedWorld), closed = await snapshot(closedWorld);
  await assert.rejects(send(saved.call, closedWorld), forbidden);
  await assert.rejects(stageScenarioReceiptDelivery(saved.call, closedWorld.store,
    { model: MODEL, row: saved.row, field: 'run' }), forbidden);
  assert.deepEqual(await snapshot(closedWorld), closed); assert.equal(closedWorld.commits.length, 1);
});

test('genuine framework rows carry admitted actor, operation, checkpoint revision and original generation correlation', async () => {
  const w = await world(), revision = await w.physical.readRevision(), saved = await save(w);
  const dispatch = await w.physical.load(WORK_DISPATCH_MODEL, asId(saved.delivery.id)); assert.ok(dispatch);
  const data = readDispatchRow(dispatch);
  assert.equal(dispatch.createdBy, w.member.user.user_id); assert.equal(dispatch.created, FIXED_NOW);
  assert.equal(data.operationId, w.envelope.operation_id); assert.equal(data.source, TARGET); assert.equal(data.occurrenceIndex, 0);
  assert.equal(data.requestSource, 'authored-request'); assert.equal(data.requestRevision, '7');
  assert.equal(data.requestBinding, BINDING); assert.equal(data.requestFrom, FROM); assert.equal(data.requestApp, APP);
  assert.equal(data.requestOwner, w.member.team.team_id);
  const association = await w.physical.load(ASSOCIATIONS, ASSOCIATION), receipt = await w.physical.load(RECEIPTS, asId(saved.delivery.id));
  assert.ok(association); assert.ok(receipt);
  for (const row of [association, receipt]) { assert.equal(row.createdBy, w.member.user.user_id); assert.equal(row.created, FIXED_NOW); }
  assert.equal(readAssociationRow(association).revision, revision + 1);
  assert.equal(readReceiptRow(receipt).receipt.revision, revision + 1);
  assert.equal(w.commits[0]!.outbox[0]!.operation, OP); assert.equal(w.commits[0]!.outbox[0]!.operationId, w.envelope.operation_id);
});

test('concurrent genuine sends, finite owner budgets and physical revision movement refuse joined effects', async () => {
  for (const mode of ['concurrent', 'work-budget', 'row-budget'] as const) {
    const w = await world(), before = await snapshot(w), revision = await w.physical.readRevision();
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table,
        bounds: mode === 'work-budget' ? { maxWork: 1, maxRows: 30 }
          : mode === 'row-budget' ? { maxWork: 1000, maxRows: 1 } : bounds });
      if (mode === 'concurrent') {
        const attempts = await Promise.allSettled([send(call, w), send(call, w, request('8'))]);
        assert.ok(attempts.every(attempt => attempt.status === 'rejected' && validation(attempt.reason)));
        await assert.rejects(session.finalize(), validation, 'catching concurrent sends leaves capture poisoned');
      } else if (mode === 'work-budget') await assert.rejects(send(call, w), validation);
      else {
        const delivery = await send(call, w);
        await assert.rejects(assign(call, w, session, delivery, true), validation);
      }
      return { result: null, writes: [], history: [], outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {} };
    } }), validation, mode);
    await assertRejected(w, before, revision);
  }
  const original = await world(), before = await snapshot(original), revision = await original.physical.readRevision();
  let moves = 0;
  const store: StoragePort = { ...original.store, load: async (model, id) => {
    if (model === WORK_DISPATCH_MODEL) {
      // A real unrelated fence moves while the genuine Work producer awaits
      // its storage reader. No producer or seal function is substituted.
      moves++;
      await original.physical.commit(makeBatch(await original.physical.readRevision()));
    }
    return original.physical.load(model, id);
  } };
  const w = { ...original, store };
  await assert.rejects(invoke({ ...w, execute: async call => {
    await begin(call, w); await send(call, w);
    throw new Error('a send beyond its admitted revision must refuse');
  } }), error => error instanceof StateError && error.code === 'busy' &&
    error.message === 'Write contention; retry the identical envelope.' && error.retryable === true);
  assert.equal(moves, MAX_ADMISSION_ATTEMPTS); assert.equal(original.commits.length, 0, 'no scenario effects or receipt cross the stale fence');
  assert.equal(await original.physical.readRevision(), revision + moves); assert.deepEqual(await snapshot(original), before);
});
