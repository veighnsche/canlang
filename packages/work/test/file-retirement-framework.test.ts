/** Actual same-load owning producers joined to State admission; opaque payloads
 * remain refused until checked source/result/File authority is released. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { ArtifactModel, CanTypeId, DomainWrite, FileReferenceInventory,
  FileReferenceStoragePort, FileRetirementAuthority, FinalizedFileIdentity,
  FrameworkFileReferenceProducer, InstalledSnapshot, ModelName, Revision, StoragePort, StoredRow } from '@canlang/contracts';
import { STATE_FILE_REFERENCE_PRODUCER, createD1Storage, createTestMemoryStorage,
  ensureD1Schema, StorageConstraintError } from '@canlang/state/storage';
import { loadArtifactDescriptors } from '@canlang/state/invocation/registry';
import { newAssociationRow, newReceiptRow, RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL } from '@canlang/state/receipt/tables';
import { stageFanoutNavigationWrite, stageFanoutOwnerScanWrite,
  FANOUT_NAVIGATION_MODEL, FANOUT_OWNER_SCAN_MODEL } from '@canlang/state/fanout/navigation';
import { asId, asModel, asOperation, asRevision, asVersion, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { WORK_FILE_REFERENCE_PRODUCER } from '../src/index.js';
import { newDispatchRow, newFanoutIntentRow, newFanoutChildRow, newOccurrenceRow, newScheduleRow,
  WORK_DISPATCH_MODEL, WORK_FANOUT_INTENT_MODEL, WORK_FANOUT_CHILD_MODEL,
  WORK_OCCURRENCE_MODEL, WORK_SCHEDULE_MODEL } from '../src/kernel/tables.js';

const producers = [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER];
const authority: FileRetirementAuthority = { app: 'documents', stateOwner: 'Documents', stateStoreId: 'state',
  fileStoreId: 'files', receiver: { app: 'documents', team: 'team', owner: 'team' } };
const snapshot: InstalledSnapshot = { owner: 'Documents', snapshotId: 'snapshot', digest: 'digest',
  installedAt: 100, installedRevision: asRevision(0) };
const MODEL = asModel('Documents.Record'), meta = { nowMs: 100, actor: 'owner' };
function inventory(): FileReferenceInventory {
  const artifactModels: ArtifactModel[] = [{ name: MODEL, deleteMode: 'archive', fields: [
    { name: 'attachment', field: { kind: 'file' }, valueType: 'file' as CanTypeId, required: false, serverOnly: false },
  ] }];
  const valueTypes = { contracts: [] };
  const canonicalModels = loadArtifactDescriptors({ artifact_version: 1, models: artifactModels,
    operations: [], valueTypes }, { by: 'members' }).models;
  return { owner: snapshot.owner, snapshotId: snapshot.snapshotId, digest: snapshot.digest,
    canonicalModels, artifactModels, valueTypes, frameworkModels: producers.flatMap(producer => producer.models) };
}
function file(ref = 'orphan'): FinalizedFileIdentity {
  return { ref, receiver: { ...authority.receiver, principal: 'alice' }, provenance: { kind: 'event',
    source: 'documents.mail', adapter: 'documents.mail', occurrenceId: 'original', fieldPath: 'attachment', itemIndex: 0 },
    contentType: 'text/plain', sizeBytes: 4, bytesDigest: 'original-digest', finalizedAtMs: 100 };
}
async function install(store: FileReferenceStoragePort, declarations = inventory()) {
  return store.installFileReferenceInventory({ expectedRevision: await store.readRevision(), authority,
    snapshot, inventory: declarations });
}
async function retire(store: FileReferenceStoragePort, ref = 'orphan') {
  return store.retireFinalizedFile({ expectedRevision: await store.readRevision(), inventory: {
    owner: snapshot.owner, snapshotId: snapshot.snapshotId, digest: snapshot.digest }, file: file(ref),
    disposition: 'orphaned', retention: { unattachedHorizonMs: 10, retentionMs: 100 }, atMs: 110,
    maxRows: 30, maxReferences: 100 });
}
async function unchanged(store: StoragePort, action: () => Promise<unknown>) {
  const revision = await store.readRevision();
  await assert.rejects(action, error => error instanceof StorageConstraintError && error.kind === 'reference');
  assert.equal(await store.readRevision(), revision);
}
function writeRow(write: DomainWrite): StoredRow {
  if (write.kind === 'remove') throw new Error('expected owning row');
  return write.row;
}
function controlRows(): Array<readonly [ModelName, StoredRow]> {
  const intent = newFanoutIntentRow({ sourceOccurrence: 'source', handler: 'Documents.each',
    cohort: 'model', members: ['record'] }, meta);
  const child = newFanoutChildRow({ fanoutId: intent.id, parentOccurrence: 'source',
    handler: 'Documents.each', recordId: 'record' }, meta);
  return [
    [asModel(WORK_DISPATCH_MODEL), newDispatchRow({ intentId: 'dispatch', operationId: 'operation',
      source: 'Documents.send', occurrenceIndex: 0, originOccurrence: null }, meta)],
    [asModel(RECEIPT_ASSOCIATION_MODEL), newAssociationRow({ recordModel: MODEL, recordId: 'record',
      field: 'delivery', deliveryId: 'delivery', source: 'Documents.send', revision: 0 }, meta)],
    [asModel(WORK_FANOUT_INTENT_MODEL), intent], [asModel(WORK_FANOUT_CHILD_MODEL), child],
    [asModel(FANOUT_NAVIGATION_MODEL), writeRow(stageFanoutNavigationWrite({ owner: 'team',
      intentRow: intent, row: null, visitedChildRow: child, meta }))],
    [asModel(FANOUT_OWNER_SCAN_MODEL), writeRow(stageFanoutOwnerScanWrite({ owner: 'team',
      row: null, visitedIntentRow: intent, meta }))],
  ];
}
let mf: Miniflare, db: D1Database;
before(async () => {
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  db = await mf.getD1Database('DB'); await ensureD1Schema(db);
});
after(async () => { await mf?.dispose(); });
const tables = ['records', 'history', 'receipts', 'outbox', 'schedules', 'unique_claims', 'snapshots',
  'migration_staging', 'migration_progress', 'migration_outcomes', 'migration_failures', 'file_reference_authority',
  'file_reference_inventories', 'file_reference_migrations', 'file_reference_publications', 'file_retirements'];
interface Backend {
  name: string;
  setup(): Promise<FileReferenceStoragePort>;
  reopen(authority: FileRetirementAuthority | undefined, bindings?: readonly FrameworkFileReferenceProducer[]): StoragePort;
}
let memory: ReturnType<typeof createTestMemoryStorage>;
const backends: Backend[] = [
  { name: 'memory', setup: async () => {
    const fresh = createTestMemoryStorage(authority, producers); memory = fresh;
    return fresh.store;
  }, reopen: (binding, supplied) => binding === undefined ? memory.reopen(undefined, supplied) : memory.reopen(binding, supplied) },
  { name: 'd1', setup: async () => {
    await db.batch([...tables.map(table => db.prepare(`DELETE FROM ${table}`)),
      db.prepare('DELETE FROM fence_log'), db.prepare('UPDATE fence SET revision=0 WHERE id=1')]);
    return createD1Storage(db, authority, producers);
  }, reopen: (binding, supplied) => binding === undefined ? createD1Storage(db, undefined, supplied) : createD1Storage(db, binding, supplied) },
];
for (const backend of backends) describe(`Framework File admission: ${backend.name}`, () => {
  it('censuses genuine mixed domain/Work/State controls and persists the original decision after genuine rebind', async () => {
    const store = await backend.setup(); await install(store);
    const rows = controlRows();
    await store.commit(makeBatch(1, { writes: [
      { kind: 'insert', model: MODEL, row: makeRow({ id: 'record', data: { attachment: { id: 'shared' } } }) },
      ...rows.map(([model, row]) => ({ kind: 'insert' as const, model, row })),
    ] }));
    await unchanged(store, () => retire(store, 'shared'));
    const fact = await retire(store);
    const rebound = backend.reopen(authority, producers) as FileReferenceStoragePort;
    assert.deepEqual(await rebound.readFinalizedFileRetirement('orphan'), fact);
    assert.deepEqual((await rebound.readFileReferenceInventory(snapshot.owner))?.inventory.frameworkModels,
      inventory().frameworkModels);
    assert.equal(await rebound.readRevision(), 3);
    // String/record IDs retain control roles even when equal to a retired File ID.
    const original = rows[0]![1];
    await rebound.commit(makeBatch(3, { writes: [{ kind: 'update', model: asModel(WORK_DISPATCH_MODEL),
      id: original.id, expectedVersion: original.version,
      row: { ...original, version: asVersion(2), archivedAt: 200, data: { ...original.data, errorMessage: 'orphan' } } }] }));
    assert.equal((await rebound.load(asModel(WORK_DISPATCH_MODEL), original.id))?.archivedAt, 200);
  });

  it('requires actual producers after reopen, including a legacy writer, with zero secondary effects', async () => {
    const store = await backend.setup(); await install(store);
    const missing = backend.reopen(authority) as FileReferenceStoragePort;
    await assert.rejects(() => missing.readFileReferenceInventory(snapshot.owner));
    const legacy = backend.reopen(undefined);
    await assert.rejects(() => legacy.commit(makeBatch(1, { writes: [{ kind: 'insert', model: MODEL,
      row: makeRow({ id: 'rejected', data: {} }) }], schedules: [{ op: 'replace', key: 'no-effect', at: 1,
      event: asOperation('Documents.due'), payload: {} }] })));
    assert.equal(await store.readRevision(), 1);
    assert.equal(await store.load(MODEL, asId('rejected')), null);
    assert.equal(await store.scheduleGet('no-effect'), null);
    const reboundLegacy = backend.reopen(undefined, producers);
    await reboundLegacy.commit(makeBatch(1, { writes: [{ kind: 'insert', model: MODEL,
      row: makeRow({ id: 'admitted', data: {} }) }] }));
    assert.equal(await store.readRevision(), 2);
  });

  it('refuses missing inventory, omitted family, source/field drift, duplicate/domain collisions before installation', async () => {
    const store = await backend.setup(), original = inventory();
    const { frameworkModels: _removed, ...omitted } = original;
    const first = original.frameworkModels[0]!;
    for (const declarations of [omitted, { ...original, frameworkModels: original.frameworkModels.slice(1) },
      { ...original, frameworkModels: [...original.frameworkModels, first] },
      { ...original, frameworkModels: original.frameworkModels.map(model => model === first ? {
        ...model, source: { ...model.source, module: 'foreign' } } : model) },
      { ...original, frameworkModels: original.frameworkModels.map(model => model === first ? {
        ...model, fields: { ...model.fields, added: { kind: 'control', value: 'string' } } } : model) },
      { ...original, canonicalModels: original.canonicalModels.map(model => ({ ...model, name: first.model })),
        artifactModels: original.artifactModels.map(model => ({ ...model, name: first.model })) },
    ]) await unchanged(store, () => install(store, declarations as FileReferenceInventory));
    assert.equal(await store.readFileReferenceInventory(snapshot.owner), null);
  });

  it('refuses unknown and malformed actual framework controls without advancing the census fence', async () => {
    const store = await backend.setup(); await install(store);
    const original = controlRows()[0]![1];
    for (const [model, row] of [
      [asModel('work.unclassified'), original],
      [asModel(WORK_DISPATCH_MODEL), { ...original, data: { ...original.data, unknown: 'extra' } }],
      [asModel(WORK_DISPATCH_MODEL), { ...original, data: { ...original.data, attempts: -1 } }],
      [asModel(WORK_DISPATCH_MODEL), { ...original, id: asId('foreign') }],
    ] as const) await unchanged(store, () => store.commit(makeBatch(1, { writes: [{ kind: 'insert', model, row }] })));
    assert.equal(await store.load(asModel(WORK_DISPATCH_MODEL), original.id), null);
  });

  it('refuses genuine opaque retained results and deferred inputs even after the owning codec accepts them', async () => {
    const store = await backend.setup(); await install(store);
    const rows = [
      [WORK_OCCURRENCE_MODEL, newOccurrenceRow({ occurrenceId: 'source', status: 'completed',
        result: { nested: { id: 'orphan' } }, code: null, message: null, recordedAtMs: 100 }, meta)],
      [WORK_OCCURRENCE_MODEL, newOccurrenceRow({ occurrenceId: 'empty', status: 'completed',
        result: null, code: null, message: null, recordedAtMs: 100 }, meta)],
      [WORK_SCHEDULE_MODEL, newScheduleRow({ occurrenceId: 'schedule', key: 'key', scopeApp: 'documents',
        scopeOwner: 'team', scopeOwnerPackage: 'Documents', at: 200, event: 'Documents.event',
        payload: { attachment: { id: 'orphan' } }, replaces: null, state: 'pending' }, meta)],
      [RECEIPT_MODEL, newReceiptRow({ deliveryId: 'delivery', revision: 0, status: 'succeeded',
        result: { id: 'orphan' }, error: null, contentRef: null, resultExpiresAtMs: null }, meta)],
    ] as const;
    for (const [model, row] of rows) {
      const producer = model === RECEIPT_MODEL ? STATE_FILE_REFERENCE_PRODUCER : WORK_FILE_REFERENCE_PRODUCER;
      producer.validateRow(asModel(model), row);
      await unchanged(store, () => store.commit(makeBatch(1, { writes: [{ kind: 'insert', model: asModel(model), row }] })));
      assert.equal(await store.load(asModel(model), row.id), null);
    }
  });

  it('retains owning framework declarations across actual target publication and activation fences', async () => {
    const store = await backend.setup(); await install(store);
    const original = controlRows()[0]![1];
    await store.commit(makeBatch(1, { writes: [{ kind: 'insert', model: asModel(WORK_DISPATCH_MODEL), row: original }] }));
    const target = { ...inventory(), snapshotId: 'target', digest: 'target-digest' }, migrationId = 'target';
    const staged = { targetModel: asModel(WORK_DISPATCH_MODEL), recordId: original.id, version: asVersion(2),
      data: { ...original.data, errorMessage: 'changed' }, parent: null, converted: true,
      created: original.created, createdBy: original.createdBy };
    await store.stageMigrationRows({ expectedRevision: asRevision(2), migrationId, rows: [staged],
      progress: { migrationId, phase: 'staged', stagedCursor: null, publishCursor: null, updatedRevision: asRevision(3) } });
    const publish = { expectedRevision: asRevision(3), migrationId, rows: [staged], history: [], drops: [],
      progress: { migrationId, phase: 'publishing' as const, stagedCursor: null, publishCursor: null, updatedRevision: asRevision(4) } };
    await unchanged(store, () => store.publishMigrationChunk({ ...publish,
      fileReferenceInventory: { ...target, frameworkModels: [] } }));
    await store.publishMigrationChunk({ ...publish, fileReferenceInventory: target });
    const flip = { expectedRevision: asRevision(4), migrationId, owner: snapshot.owner,
      snapshot: { ...snapshot, snapshotId: target.snapshotId, digest: target.digest }, renameFromOwner: null,
      invalidatedIntentIds: [], outcomes: [], fileReferenceInventory: target };
    await unchanged(store, () => store.flipInstalledSnapshot({ ...flip,
      fileReferenceInventory: { ...target, frameworkModels: [] } }));
    assert.deepEqual(await store.flipInstalledSnapshot(flip), { flipped: true, revision: 5 });
    assert.deepEqual((await store.readFileReferenceInventory(snapshot.owner))?.inventory, target);
    assert.equal((await store.load(asModel(WORK_DISPATCH_MODEL), original.id))?.data.errorMessage, 'changed');
    assert.deepEqual(await store.flipInstalledSnapshot(flip), { flipped: false, revision: 5 });
  });
});
it('rejects duplicated actual owning exports at trusted binding construction', () => {
  assert.throws(() => createTestMemoryStorage(authority, [WORK_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]));
});
