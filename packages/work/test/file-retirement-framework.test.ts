/** Actual same-load owning producers joined to State admission; opaque payloads
 * remain refused until checked source/result/File authority is released. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Miniflare } from 'miniflare';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { blobKeyForFile, describeForReceipt, sha256Hex } from '@canlang/files';
import { createSqliteFileStore, createSqliteFileBindings } from '@canlang/files/host/sqlite';
import { WORK_FILE_REFERENCE_PRODUCER as PUBLIC_WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work';
import type { D1Database } from '@cloudflare/workers-types';
import type { ArtifactModel, CanTypeId, DomainWrite, FileReferenceInventory,
  FileReferenceStoragePort, FileRetirementAuthority, FinalizedFileIdentity,
  FrameworkFileReferenceProducer, InstalledSnapshot, ModelName, Revision, StagedRow, StoragePort, StoredRow } from '@canlang/contracts';
import { STATE_FILE_REFERENCE_PRODUCER, createD1Storage, createTestMemoryStorage,
  ensureD1Schema, StorageConstraintError } from '@canlang/state/storage';
import { StateError } from '@canlang/state';
import { activate, resumeMigration, validateTransition } from '@canlang/state/migration';
import { buildModelTableFromCanonical } from '@canlang/state/mutation/models';
import { normalizeValueTypes } from '@canlang/values';
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


describe('actual Memory migration engine with mixed State and Work File inventory', () => {
  const clock = { nowMs: () => 888 };
  function enginePlan(installed: InstalledSnapshot, old: FileReferenceInventory, target: FileReferenceInventory,
    migrationId: string) {
    const table = (declarations: FileReferenceInventory) => buildModelTableFromCanonical(declarations.canonicalModels,
      { valueSchema: normalizeValueTypes(declarations.valueTypes, declarations.canonicalModels.map(model => model.name)).valueSchema });
    const oldModels = table(old), desiredModels = table(target);
    const plan = validateTransition(installed, { migrationId, owner: installed.owner,
      fromSnapshotId: installed.snapshotId, fromDigest: installed.digest,
      toSnapshotId: target.snapshotId, toDigest: target.digest, bodyDigest: 'mixed-engine-body', directives: [] },
    oldModels, desiredModels);
    return { plan, oldModels, desiredModels };
  }
  async function stagedMigration(migrationId: string, ids: readonly string[]) {
    const store = createTestMemoryStorage(authority, producers).store;
    const old = inventory(), target = { ...inventory(), snapshotId: 'mixed-target', digest: 'mixed-target-digest' };
    assert.equal(old.frameworkModels.length, 13); assert.deepEqual(target.frameworkModels, old.frameworkModels);
    await install(store, old);
    const controls = controlRows();
    const domain = ids.map(id => ({ ...makeRow({ id, data: { attachment: { id: `file-${id}` } } }), parent: null }));
    await store.commit(makeBatch(await store.readRevision(), { writes: [
      ...domain.map(row => ({ kind: 'insert' as const, model: MODEL, row })),
      ...controls.map(([model, row]) => ({ kind: 'insert' as const, model, row })),
    ] }));
    const engine = enginePlan((await store.readInstalledSnapshot(old.owner))!, old, target, migrationId);
    const staged: StagedRow[] = domain.map(row => ({ targetModel: MODEL, recordId: row.id,
      version: row.version, data: row.data, parent: null, converted: false,
      created: row.created, createdBy: row.createdBy, archivedAt: row.archivedAt }));
    const revision = await store.readRevision();
    await store.stageMigrationRows({ expectedRevision: revision, migrationId, rows: staged,
      progress: { migrationId, phase: 'staged', stagedCursor: null, publishCursor: null,
        updatedRevision: asRevision(revision + 1) } });
    return { store, old, target, controls, domain, staged, engine };
  }
  it('activate carries all 13 owning families while publishing only real staged domain rows', async () => {
    const migrationId = 'mixed-engine-activate';
    const { store, target, controls, domain, engine } = await stagedMigration(migrationId, ['record']);
    const activated = await activate({ store, ...engine, inventory: [], chunkSize: 1, clock,
      fileReferenceInventory: target });
    assert.equal(activated.flipped, true);
    const installed = (await store.readFileReferenceInventory(target.owner))!;
    assert.deepEqual(installed.inventory, target); assert.equal(installed.snapshot.installedAt, 888);
    assert.equal(installed.snapshot.installedRevision, activated.revision);
    assert.equal((await store.readMigrationProgress(migrationId))?.phase, 'active');
    assert.deepEqual((await store.query({ model: MODEL, authority: 'owner', order: [{ field: 'id', direction: 'asc' }] }))
      .map(row => row.data), domain.map(row => row.data));
    for (const [model, original] of controls) assert.deepEqual(await store.load(model, original.id), original);
    const retired = await store.retireFinalizedFile({ expectedRevision: activated.revision,
      inventory: { owner: target.owner, snapshotId: target.snapshotId, digest: target.digest }, file: file(),
      disposition: 'orphaned', retention: { unattachedHorizonMs: 10, retentionMs: 100 }, atMs: 900,
      maxRows: 30, maxReferences: 100 });
    assert.deepEqual(retired.snapshot, installed.snapshot);
  });
  it('resumeMigration completes an interrupted real mixed-inventory publication without changing framework controls', async () => {
    const migrationId = 'mixed-engine-resume';
    const { store, target, controls, domain, staged, engine } = await stagedMigration(migrationId, ['record', 'second']);
    const revision = await store.readRevision(), first = staged[0]!;
    await store.publishMigrationChunk({ expectedRevision: revision, migrationId, rows: [first], history: [], drops: [],
      fileReferenceInventory: target, progress: { migrationId, phase: 'publishing', stagedCursor: null,
        publishCursor: { model: MODEL, recordId: first.recordId }, updatedRevision: asRevision(revision + 1) } });
    assert.equal((await store.readInstalledSnapshot(snapshot.owner))?.snapshotId, snapshot.snapshotId);
    const resumed = await resumeMigration({ store, ...engine, mappers: new Map(), oldLocks: new Map(),
      inventory: [], chunkSize: 1, clock, fileReferenceInventory: target });
    assert.equal(resumed.flip?.flipped, true); assert.equal(resumed.progress?.phase, 'active');
    assert.deepEqual((await store.readFileReferenceInventory(target.owner))?.inventory, target);
    assert.equal((await store.readInstalledSnapshot(target.owner))?.installedAt, 888);
    assert.deepEqual((await store.query({ model: MODEL, authority: 'owner', order: [{ field: 'id', direction: 'asc' }] }))
      .map(row => row.data), domain.map(row => row.data));
    for (const [model, original] of controls) assert.deepEqual(await store.load(model, original.id), original);
  });
  it('a copied adapter cannot authorize nonempty owning framework inventory or advance migration state', async () => {
    const migrationId = 'mixed-engine-copied-store';
    const { store, old, target, controls, domain, engine } = await stagedMigration(migrationId, ['record']);
    const revision = await store.readRevision(), progress = await store.readMigrationProgress(migrationId);
    const installed = await store.readFileReferenceInventory(old.owner);
    await assert.rejects(activate({ store: { ...store }, ...engine, inventory: [], chunkSize: 1, clock,
      fileReferenceInventory: target }), error => error instanceof StateError && error.code === 'validation');
    assert.equal(await store.readRevision(), revision);
    assert.deepEqual(await store.readMigrationProgress(migrationId), progress);
    assert.deepEqual(await store.readFileReferenceInventory(old.owner), installed);
    assert.equal(await store.readMigrationFailure(migrationId), null);
    for (const original of domain) assert.deepEqual(await store.load(MODEL, original.id), original);
    for (const [model, original] of controls) assert.deepEqual(await store.load(model, original.id), original);
  });
});

describe('genuine persisted State retirement consumed by separate Files SQLite', () => {
  const bytes = new TextEncoder().encode('%PDF-1.4\ntrailer\n');
  const receiver = { ...authority.receiver, principal: 'alice' };
  const retention = { unattachedHorizonMs: 10, retentionMs: 100 };
  const actualProducers = [STATE_FILE_REFERENCE_PRODUCER, PUBLIC_WORK_FILE_REFERENCE_PRODUCER];
  const start = Date.parse('2026-10-11T12:00:00Z');

  async function stateTables(database: D1Database) {
    // D1's reserved _cf_* provider tables prohibit reads through its public API.
    const names = (await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' ORDER BY name").all<{ name: string }>()).results;
    const result: Record<string, unknown> = {};
    for (const { name } of names) {
      const rows = (await database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()).results;
      result[name] = rows.map(row => JSON.stringify(row)).sort();
    }
    return result;
  }

  for (const disposition of ['orphaned', 'expired'] as const) {
    it(`${disposition}: genuine issuance survives physical rollback and both-store reopen without changing State`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'can-state-files-retirement-'));
      const filePath = join(dir, 'files.sqlite'), d1Persist = join(dir, 'd1');
      let physical = createSqliteFileStore(filePath);
      let native: Miniflare | null = null;
      let database!: D1Database, state!: FileReferenceStoragePort;
      let now = start;
      const clock = { nowMs: () => now };
      const options = { clock, intentTtlMs: 1000, urlBase: 'https://documents.example.test',
        policy: { types: ['application/pdf'], maxBytes: bytes.length } };
      const sql = (action: (connection: DatabaseSync) => void) => {
        const connection = new DatabaseSync(filePath);
        try { action(connection); } finally { connection.close(); }
      };
      function fileTables() {
        const result: Record<string, string[]> = {};
        sql(connection => {
          const names = connection.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
          for (const entry of names) {
            const name = entry.name as string;
            result[name] = connection.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
              .map(row => JSON.stringify(row)).sort();
          }
        });
        return result;
      }
      function fileRefusal(action: () => unknown) {
        const before = fileTables();
        assert.throws(action);
        assert.deepEqual(fileTables(), before);
      }
      async function asyncFileRefusal(action: () => Promise<unknown>, message?: RegExp) {
        const before = fileTables();
        if (message === undefined) await assert.rejects(action);
        else await assert.rejects(action, message);
        assert.deepEqual(fileTables(), before);
      }
      let boundAuthority!: FileRetirementAuthority;
      async function openState() {
        native = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}',
          d1Databases: { DB: 'retirement-consumer' }, d1Persist });
        database = await native.getD1Database('DB');
        await ensureD1Schema(database);
        state = createD1Storage(database, boundAuthority, actualProducers);
      }
      async function closeState() {
        const current = native;
        native = null;
        if (current !== null) await current.dispose();
      }
      async function reopenBoth() {
        physical.close(); await closeState();
        physical = createSqliteFileStore(filePath);
        assert.equal(physical.fileStoreId, boundAuthority.fileStoreId);
        await openState();
      }
      const boundFiles = () => createSqliteFileBindings(physical, {
        ...options, fileRetirement: { storage: state, retention },
      });
      try {
        assert.equal(PUBLIC_WORK_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER);
        assert.equal(actualProducers.flatMap(producer => producer.models).length, 13);
        const upload = createSqliteFileBindings(physical, options);
        const request = { upload_id: 'original-upload', operation: 'Documents.Record.create', field: '/attachment',
          arguments: {}, name: 'original.pdf', type: 'application/pdf', size: String(bytes.length) };
        const binding = { adapter: 'deployment.web', deliveryId: 'original-delivery', resultPath: 'receipt' };
        const created = upload.createIntent({ request, receiver, binding });
        assert.equal(created.status, 'granted');
        if (created.status !== 'granted') throw new Error('Expected actual upload grant');
        assert.deepEqual(upload.append(created.intentId, receiver, bytes, 0), { status: 'appended', receivedBytes: bytes.length });
        assert.equal(upload.complete(created.intentId, receiver).status, 'completed');
        const finalized = upload.finalize({ intentId: created.intentId, retryId: request.upload_id,
          bytesDigest: sha256Hex(bytes), caller: receiver });
        assert.equal(finalized.status, 'finalized');
        if (finalized.status !== 'finalized') throw new Error('Expected actual finalized file');
        const ref = finalized.result.file;
        assert.equal(upload.recordAttachment(ref, 'Documents.Record/live', receiver).status, 'attached');
        const original = physical.files.get(ref)!;
        const identity: FinalizedFileIdentity = { ref, receiver: { ...original.owner },
          provenance: structuredClone(original.file.provenance), contentType: original.file.contentType,
          sizeBytes: original.file.sizeBytes, bytesDigest: original.file.bytesDigest, finalizedAtMs: original.finalizedAtMs };
        assert.deepEqual(identity.provenance, { kind: 'request', ...receiver, ...binding });
        boundAuthority = { ...authority, stateStoreId: 'persisted-state', fileStoreId: physical.fileStoreId,
          receiver: { ...authority.receiver } };
        await openState();
        const declarations = inventory();
        await state.installFileReferenceInventory({ expectedRevision: await state.readRevision(), authority: boundAuthority,
          snapshot: { ...snapshot, installedAt: start }, inventory: declarations });
        const live = { ...makeRow({ id: 'live', created: start, updated: start, data: { attachment: { id: ref } } }), parent: null };
        const archived = { ...makeRow({ id: 'archived', created: start, updated: start,
          archivedAt: start, data: { attachment: { id: ref } } }), parent: null };
        await state.commit(makeBatch(await state.readRevision(), { writes: [
          { kind: 'insert', model: MODEL, row: live }, { kind: 'insert', model: MODEL, row: archived },
          ...controlRows().map(([model, row]) => ({ kind: 'insert' as const, model, row })),
        ] }));
        now = start + retention.unattachedHorizonMs;
        const retireInput = async () => ({ expectedRevision: await state.readRevision(), inventory: {
          owner: declarations.owner, snapshotId: declarations.snapshotId, digest: declarations.digest },
          file: identity, disposition, retention, atMs: now, maxRows: 30, maxReferences: 100 });
        const beforeReferenceRefusal = await stateTables(database);
        await asyncFileRefusal(() => state.retireFinalizedFile({ expectedRevision: asRevision(2), inventory: {
          owner: declarations.owner, snapshotId: declarations.snapshotId, digest: declarations.digest },
          file: identity, disposition: 'orphaned', retention, atMs: now, maxRows: 30, maxReferences: 100 }));
        assert.deepEqual(await stateTables(database), beforeReferenceRefusal);
        if (disposition === 'orphaned') {
          await state.commit(makeBatch(await state.readRevision(), { writes: [{ kind: 'update', model: MODEL,
            id: live.id, expectedVersion: live.version, row: { ...live, version: asVersion(2), data: {} } }] }));
          const archivedOnly = await stateTables(database);
          await asyncFileRefusal(async () => state.retireFinalizedFile(await retireInput()));
          assert.deepEqual(await stateTables(database), archivedOnly);
          await state.commit(makeBatch(await state.readRevision(), { writes: [{ kind: 'remove', model: MODEL,
            id: archived.id, expectedVersion: archived.version }] }));
        } else now = start + retention.retentionMs;
        const decision = await state.retireFinalizedFile(await retireInput());
        assert.deepEqual(decision.file, identity);
        assert.equal(decision.authority.fileStoreId, physical.fileStoreId);
        const permanentState = await stateTables(database);
        const cleanup = boundFiles();
        await asyncFileRefusal(() => createSqliteFileBindings(physical, { ...options,
          policy: { ...options.policy, maxBytes: bytes.length - 1 },
          fileRetirement: { storage: state, retention } }).deleteRetiredFile(ref));
        assert.deepEqual(physical.files.get(ref), original);
        assert.deepEqual(physical.blobs.read(blobKeyForFile(ref)), bytes);
        sql(connection => connection.exec("CREATE TRIGGER interrupt_retirement BEFORE DELETE ON files_blobs BEGIN SELECT RAISE(ABORT, 'physical deletion interrupted'); END"));
        await asyncFileRefusal(() => cleanup.deleteRetiredFile(ref), /physical deletion interrupted/);
        assert.deepEqual(physical.files.get(ref), original);
        assert.deepEqual(physical.blobs.read(blobKeyForFile(ref)), bytes);
        sql(connection => assert.equal(connection.prepare('SELECT count(*) AS n FROM files_retirement_journal').get()!.n, 0));
        assert.deepEqual(await state.readFinalizedFileRetirement(ref), decision);
        assert.deepEqual(await stateTables(database), permanentState);

        await reopenBoth();
        assert.deepEqual(await state.readFinalizedFileRetirement(ref), decision);
        const legacyState = createD1Storage(database, undefined, actualProducers);
        await asyncFileRefusal(() => legacyState.commit(makeBatch(decision.retiredRevision, { writes: [{ kind: 'insert', model: MODEL,
          row: { ...makeRow({ id: 'revived', data: { attachment: { id: ref } } }), parent: null } }],
          schedules: [{ op: 'replace', key: 'no-secondary-effect', at: now, event: asOperation('Documents.due'), payload: {} }] })));
        assert.deepEqual(await stateTables(database), permanentState);
        const omitted = createSqliteFileBindings(physical, options);
        await asyncFileRefusal(() => omitted.deleteRetiredFile(ref));
        fileRefusal(() => omitted.runRetention(retention));
        const foreign = createD1Storage(database, { ...boundAuthority, stateStoreId: 'foreign-state' }, actualProducers);
        fileRefusal(() => createSqliteFileBindings(physical, { ...options, fileRetirement: { storage: foreign, retention } }));
        fileRefusal(() => physical.blobs.remove(blobKeyForFile(ref)));
        fileRefusal(() => physical.files.put({ ...original, file: { ...original.file, sizeBytes: 1 } }));
        sql(connection => connection.exec('DROP TRIGGER interrupt_retirement'));
        assert.equal(await boundFiles().deleteRetiredFile(ref), 'deleted');
        assert.deepEqual(physical.files.get(ref), { ...original, state: disposition });
        assert.equal(physical.blobs.read(blobKeyForFile(ref)), null);
        fileRefusal(() => physical.files.put(original));
        fileRefusal(() => physical.blobs.write(blobKeyForFile(ref), bytes));
        fileRefusal(() => physical.blobs.append(blobKeyForFile(ref), bytes));
        assert.deepEqual(describeForReceipt({ files: physical.files, blobs: physical.blobs }, ref),
          { file: ref, status: 'redacted', contentType: 'application/pdf', sizeBytes: bytes.length });
        let journal = '';
        sql(connection => {
          journal = connection.prepare('SELECT json FROM files_retirement_journal WHERE id=?').get(ref)!.json as string;
          const saved = JSON.parse(journal);
          assert.deepEqual(saved.retirement, decision);
          assert.equal(typeof saved.tombstone, 'string');
          assert.equal(saved.tombstone,
            connection.prepare('SELECT json FROM files_finalized WHERE id=?').get(ref)!.json);
        });
        assert.deepEqual(await stateTables(database), permanentState);
        for (const changed of [{ retention: { ...retention, retentionMs: 101 } },
          { disposition: disposition === 'orphaned' ? 'expired' as const : 'orphaned' as const }]) {
          await asyncFileRefusal(async () => state.retireFinalizedFile({ ...await retireInput(), ...changed }));
          assert.deepEqual(await stateTables(database), permanentState);
        }
        await reopenBoth();
        assert.deepEqual(await state.readFinalizedFileRetirement(ref), decision);
        assert.equal(await boundFiles().deleteRetiredFile(ref), 'already-deleted');
        sql(connection => connection.prepare('DELETE FROM files_retirement_journal WHERE id=?').run(ref));
        await asyncFileRefusal(() => boundFiles().deleteRetiredFile(ref));
        sql(connection => connection.prepare('INSERT INTO files_retirement_journal(id,json) VALUES(?,?)').run(ref, journal));
        assert.equal(await boundFiles().deleteRetiredFile(ref), 'already-deleted');
        assert.deepEqual(physical.files.get(ref), { ...original, state: disposition });
        assert.deepEqual(await stateTables(database), permanentState);
      } finally {
        physical.close(); await closeState();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
