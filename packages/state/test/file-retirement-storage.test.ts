/** Authoritative File admission conformance against the actual memory, D1
 * (Miniflare) and Durable Object SQLite (workerd) adapters. The DO proxy only
 * transports calls: all census, admission and atomic writes execute in workerd. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { ArtifactModel, CanTypeId, CanValue, CompileArtifact, FileReferenceInventory, FileReferenceStoragePort,
  FileRetirementAuthority, FinalizedFileIdentity, FrameworkFilePayloadOrigin, FrameworkOpaqueDeclarationSet,
  FrameworkOpaqueDeliveryContext, FrameworkOpaqueValueDefault, InstalledSnapshot, MigrationProgress, ModelName, RetainedFinalizedFile,
  RetireFinalizedFile, StagedRow, StoragePort, StoredRow, WireValue } from '@canlang/contracts';
import { createTestMemoryStorage } from '../src/storage/memory.js';
import { STATE_FILE_REFERENCE_PRODUCER } from '../src/storage/index.js';
import { newAssociationRow, newReceiptRow, withReceiptRowData, RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL } from '../src/receipt/tables.js';
import { stageFanoutOwnerScanWrite, FANOUT_OWNER_SCAN_MODEL } from '../src/fanout/navigation.js';
import { FenceConflictError, StorageConstraintError, type StorageConstraintKind } from '../src/storage/port.js';
import { createD1Storage, ensureSchema } from '../src/storage/d1.js';
import { isGeneratedOperationDef, loadArtifactDescriptors } from '../src/invocation/registry.js';
import { encodeValue, normalizeValueTypes } from '@canlang/values';
import { buildModelTableFromCanonical } from '../src/mutation/models.js';
import { activate, resumeMigration, validateTransition } from '../src/migration/index.js';
import { asId, asModel, asOperation, asOperationId, asRevision, asVersion, makeBatch, makeRow } from './invocation/fixtures.js';

const MODEL = asModel('Documents.Record');
const authority: FileRetirementAuthority = { app: 'documents', stateOwner: 'Documents',
  stateStoreId: 'documents-state', fileStoreId: 'documents-files',
  receiver: { app: 'documents', team: 'team', owner: 'team' } };
const snapshot: InstalledSnapshot = { owner: 'Documents', snapshotId: 'snapshot-1', digest: 'digest-1',
  installedRevision: asRevision(0), installedAt: 100 };
const retention = { unattachedHorizonMs: 100, retentionMs: 500 };
function file(ref = 'file-original'): FinalizedFileIdentity {
  return { ref, receiver: { ...authority.receiver, principal: 'alice' },
    provenance: { kind: 'event', source: 'documents.mail', adapter: 'documents.mail',
      occurrenceId: 'delivery-original', fieldPath: 'attachments', itemIndex: 0 },
    contentType: 'text/plain', sizeBytes: 4, bytesDigest: 'sha256-original', finalizedAtMs: 1_000 };
}
function inventory(json = false, target = false): FileReferenceInventory {
  const models: ArtifactModel[] = [{ name: MODEL, deleteMode: 'archive', fields: [
    { name: 'attachment', field: { kind: json ? 'json' : 'file' }, ...(json ? {} : { valueType: 'file' as CanTypeId }),
      required: false, serverOnly: false },
    { name: 'label', field: { kind: 'string' }, valueType: 'text' as CanTypeId,
      required: false, serverOnly: false },
    { name: 'optional', field: { kind: 'file' }, valueType: 'file?' as CanTypeId,
      nullable: true, required: false, serverOnly: false },
    { name: 'attachments', field: { kind: 'file' }, valueType: 'file[]' as CanTypeId,
      array: { required: false }, max: 8, required: false, serverOnly: false },
    { name: 'packet', field: { kind: 'nominal', name: 'Documents.Packet' },
      valueType: 'Documents.Packet?' as CanTypeId, nullable: true, required: false, serverOnly: false },
    { name: 'packets', field: { kind: 'nominal', name: 'Documents.Packet' },
      valueType: 'Documents.Packet[]' as CanTypeId, array: { required: false }, max: 8,
      required: false, serverOnly: false },
  ] }];
  const valueTypes = { contracts: [
    { name: 'Documents.Detail', fields: [{ name: 'attachment', type: 'file?' }] },
    { name: 'Documents.Packet', fields: [
      { name: 'detail', type: 'Documents.Detail?' }, { name: 'attachments', type: 'file[]', max: 8 },
      { name: 'choice', type: 'file|Documents.Detail' },
    ] },
  ] };
  const loaded = loadArtifactDescriptors({ artifact_version: 1, models, operations: [], valueTypes }, { by: 'members' });
  return { owner: snapshot.owner, snapshotId: target ? 'snapshot-2' : snapshot.snapshotId,
    digest: target ? 'digest-2' : snapshot.digest, canonicalModels: loaded.models, artifactModels: models, valueTypes, frameworkModels: [] };
}
const identity = (declarations: FileReferenceInventory) => ({ owner: declarations.owner,
  snapshotId: declarations.snapshotId, digest: declarations.digest });
function request(revision: number, declarations = inventory(), patch: Partial<RetireFinalizedFile> = {}): RetireFinalizedFile {
  return { expectedRevision: asRevision(revision), inventory: identity(declarations), file: file(),
    disposition: 'orphaned', retention, atMs: 1_100, maxRows: 20, maxReferences: 100, ...patch };
}
function packet(ref: string) {
  return { detail: { attachment: { id: ref } }, attachments: [{ id: ref }],
    choice: { type: 'file', value: { id: ref } } };
}

let d1Mf: Miniflare | undefined, doMf: Miniflare | undefined;
let database: D1Database;
const tables = ['records', 'history', 'receipts', 'outbox', 'schedules', 'unique_claims', 'snapshots',
  'migration_staging', 'migration_progress', 'migration_outcomes', 'migration_failures',
  'file_reference_authority', 'file_reference_inventories', 'file_reference_migrations',
  'file_reference_publications', 'file_retirements'];
async function doPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  assert.ok(doMf);
  const response = await doMf.dispatchFetch(`http://localhost${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json() as Record<string, unknown>;
  if (result['ok'] !== true) {
    const remote = result['error'] as { name: string; message: string; expected?: number; actual?: number | null;
      kind?: StorageConstraintKind; detail?: string };
    if (remote.name === 'FenceConflictError') throw new FenceConflictError(asRevision(remote.expected!),
      remote.actual == null ? null : asRevision(remote.actual));
    if (remote.name === 'StorageConstraintError') throw new StorageConstraintError(remote.kind!, remote.detail!);
    const error = new Error(remote.message); error.name = remote.name; throw error;
  }
  return result;
}
function doProxy(): FileReferenceStoragePort {
  return new Proxy({ fileRetirementAuthority: authority }, {
    get(target, property) {
      if (property === 'then') return undefined;
      if (property === 'fileRetirementAuthority') return target.fileRetirementAuthority;
      return async (...args: unknown[]) => (await doPost('/call', { method: property, args }))['value'];
    },
  }) as FileReferenceStoragePort;
}
before(async () => {
  d1Mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] });
  database = await d1Mf.getD1Database('DB'); await ensureSchema(database);
});
after(async () => { await d1Mf?.dispose(); await doMf?.dispose(); });
interface Backend {
  name: string;
  setup(): Promise<FileReferenceStoragePort>;
  reopen(store: FileReferenceStoragePort, bound: boolean | FileRetirementAuthority): Promise<StoragePort>;
}
let memoryReopen: ReturnType<typeof createTestMemoryStorage>['reopen'];
const reopenBinding = (bound: boolean | FileRetirementAuthority) => bound === false ? undefined : bound === true ? authority : bound;
const backends: Backend[] = [
  { name: 'memory', setup: async () => {
    const memory = createTestMemoryStorage(authority); memoryReopen = memory.reopen; return memory.store;
  }, reopen: async (_store, bound) => {
    const binding = reopenBinding(bound); return binding === undefined ? memoryReopen() : memoryReopen(binding);
  } },
  { name: 'd1', setup: async () => {
    await database.batch([...tables.map(table => database.prepare(`DELETE FROM ${table}`)),
      database.prepare('DELETE FROM fence_log'), database.prepare('UPDATE fence SET revision = 0 WHERE id = 1')]);
    return createD1Storage(database, authority);
  }, reopen: async (_store, bound) => {
    const binding = reopenBinding(bound); return binding === undefined ? createD1Storage(database) : createD1Storage(database, binding);
  } },
  { name: 'do', setup: async () => {
    doMf ??= new Miniflare({ modules: true,
      scriptPath: fileURLToPath(new URL('./storage/do-test-worker.js', import.meta.url)),
      modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }], compatibilityDate: '2025-01-01',
      durableObjects: { TEST_DO: { className: 'TestDO', useSQLite: true, unsafePreventEviction: true } } });
    await doPost('/reset', {}); await doPost('/reopen', { authority }); return doProxy();
  }, reopen: async (_store, bound) => {
    const binding = reopenBinding(bound); await doPost('/reopen', binding === undefined ? {} : { authority: binding }); return doProxy();
  } },
];
async function install(store: FileReferenceStoragePort, declarations = inventory()) {
  await store.installFileReferenceInventory({ expectedRevision: await store.readRevision(), authority,
    snapshot: { ...snapshot, ...identity(declarations) }, inventory: declarations });
}
async function insert(store: StoragePort, data: Record<string, unknown>, id = 'row', archivedAt: number | null = null) {
  const row = makeRow({ id, data, archivedAt });
  await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: MODEL, row }] }));
  return row;
}
function progress(migrationId: string, revision: number, phase: MigrationProgress['phase']): MigrationProgress {
  return { migrationId, phase, stagedCursor: null, publishCursor: null, updatedRevision: asRevision(revision) };
}
function staged(data: Record<string, unknown>): StagedRow {
  return { targetModel: MODEL, recordId: asId('staged'), version: asVersion(1), data, parent: null,
    converted: false, created: 100, createdBy: 'alice' };
}
async function noEffects(store: StoragePort, action: () => Promise<unknown>) {
  const revision = await store.readRevision();
  await assert.rejects(action);
  assert.equal(await store.readRevision(), revision);
}

for (const backend of backends) describe(`File retirement storage: ${backend.name}`, () => {
  it('installs at the actual revision and preserves an existing pointer installation time/revision', async () => {
    const store = await backend.setup();
    await store.flipInstalledSnapshot({ expectedRevision: asRevision(0), migrationId: 'bootstrap', owner: snapshot.owner,
      snapshot, renameFromOwner: null, invalidatedIntentIds: [], outcomes: [], fileReferenceInventory: inventory() });
    const original = await store.readInstalledSnapshot(snapshot.owner); assert.ok(original);
    await store.installFileReferenceInventory({ expectedRevision: await store.readRevision(), authority,
      snapshot: { ...snapshot, installedRevision: asRevision(999), installedAt: 999 }, inventory: inventory() });
    assert.deepEqual((await store.readFileReferenceInventory(snapshot.owner))?.snapshot, original);
    assert.deepEqual(await store.readInstalledSnapshot(snapshot.owner), original);
    const fresh = await backend.setup(); await install(fresh);
    assert.equal((await fresh.readFileReferenceInventory(snapshot.owner))?.snapshot.installedRevision, 1);
    const revision = await fresh.readRevision(); await install(fresh);
    assert.equal(await fresh.readRevision(), revision);
  });

  if (backend.name !== 'memory') it('upgrades an actual old authority table additively and idempotently without backfilling File facts', async () => {
    const store = await backend.setup(); await install(store);
    const stagedRow = await insert(store, { attachment: { id: 'legacy-schema-file' } });
    const row = await store.load(MODEL, stagedRow.id); assert.ok(row);
    const installed = await store.readFileReferenceInventory(snapshot.owner);
    const pointer = await store.readInstalledSnapshot(snapshot.owner), revision = await store.readRevision();
    async function sql(statement: string): Promise<Record<string, unknown>[]> {
      if (backend.name === 'd1') return (await database.prepare(statement).all<Record<string, unknown>>()).results;
      return (await doPost('/exec', { sql: statement }))['rows'] as Record<string, unknown>[];
    }
    const originalAuthority = await sql('SELECT id, authority FROM file_reference_authority');
    assert.equal(originalAuthority.length, 1, 'an installed authority row must predate the upgrade');
    await sql('ALTER TABLE file_reference_authority DROP COLUMN opaque_lifetimes');
    assert.ok(!(await sql('PRAGMA table_info(file_reference_authority)')).some(column => column['name'] === 'opaque_lifetimes'),
      'the additive migration must start from the actual old table shape');
    for (let attempt = 0; attempt < 2; attempt++) {
      if (backend.name === 'd1') await ensureSchema(database);
      else await doPost('/reopen', { authority });
      assert.deepEqual(await sql('SELECT id, authority FROM file_reference_authority'), originalAuthority);
      const rows = await sql('SELECT opaque_lifetimes FROM file_reference_authority');
      assert.deepEqual(rows, [{ opaque_lifetimes: '[]' }], 'schema upgrade must not infer original opaque File facts');
      assert.deepEqual(await store.readFileReferenceInventory(snapshot.owner), installed);
      assert.deepEqual(await store.readInstalledSnapshot(snapshot.owner), pointer);
      assert.deepEqual(await store.load(MODEL, row.id), row);
      assert.equal(await store.readRevision(), revision);
    }
  });

  it('derives every nested, collection, optional and archived File occurrence and refuses incomplete bounds', async () => {
    const store = await backend.setup(); await install(store);
    await insert(store, { optional: null, packet: null, attachments: [] }, 'absent');
    const refs = ['direct', 'optional', 'array', 'detail', 'choice', 'packet-array'];
    await insert(store, { attachment: { id: refs[0] }, optional: { id: refs[1] }, attachments: [{ id: refs[2] }],
      packet: { detail: { attachment: { id: refs[3] } }, attachments: [], choice: { type: 'file', value: { id: refs[4] } } },
      packets: [packet(refs[5]!)] }, 'archived', 100);
    for (const ref of refs) {
      await noEffects(store, () => store.retireFinalizedFile(request(3, inventory(), { file: file(ref) })));
      assert.equal(await store.readFinalizedFileRetirement(ref), null);
    }
    const unrelated = request(3, inventory(), { file: file('unrelated') });
    await noEffects(store, () => store.retireFinalizedFile({ ...unrelated, maxRows: 1 }));
    await noEffects(store, () => store.retireFinalizedFile({ ...unrelated, maxReferences: 7 }));
    assert.equal(await store.readFinalizedFileRetirement('unrelated'), null);
    const fact = await store.retireFinalizedFile({ ...unrelated, maxRows: 2, maxReferences: 8 });
    assert.equal(fact.censusRevision, 3);
  });

  it('anchors orphan and expiry horizons to original finalization, allowing expiry of current references', async () => {
    const store = await backend.setup(); await install(store);
    await noEffects(store, () => store.retireFinalizedFile(request(1, inventory(), { atMs: 1_099 })));
    const orphan = await store.retireFinalizedFile(request(1)); assert.equal(orphan.retiredAtMs, 1_100);
    await insert(store, { attachment: { id: 'current' } });
    await noEffects(store, () => store.retireFinalizedFile(request(3, inventory(), {
      file: file('current'), disposition: 'expired', atMs: 1_499 })));
    const expired = await store.retireFinalizedFile(request(3, inventory(), {
      file: file('current'), disposition: 'expired', atMs: 1_500 }));
    assert.equal(expired.disposition, 'expired');
    assert.deepEqual((await store.load(MODEL, asId('row')))?.data, { attachment: { id: 'current' } });
  });

  it('persists immutable retirement evidence across reopening and retries without another revision', async () => {
    let store = await backend.setup(); await install(store);
    const original = await store.retireFinalizedFile(request(1));
    store = await backend.reopen(store, true) as FileReferenceStoragePort;
    assert.deepEqual(await store.readFinalizedFileRetirement(file().ref), original);
    assert.deepEqual(await store.retireFinalizedFile(request(2, inventory(), { atMs: 99_999 })), original);
    assert.equal(await store.readRevision(), 2);
    for (const changed of [ { file: { ...file(), bytesDigest: 'altered' } },
      { file: { ...file(), finalizedAtMs: 1_001 } }, { retention: { ...retention, retentionMs: 501 } },
      { disposition: 'expired' as const }, { inventory: { ...identity(inventory()), digest: 'altered' } } ]) {
      await noEffects(store, () => store.retireFinalizedFile(request(2, inventory(), changed)));
    }
    assert.deepEqual(await store.readFinalizedFileRetirement(file().ref), original);
  });

  it('enforces permanent admission through a reopened legacy adapter without row or schedule effects', async () => {
    const bound = await backend.setup(); await install(bound); await bound.retireFinalizedFile(request(1));
    const legacy = await backend.reopen(bound, false);
    await noEffects(legacy, () => legacy.commit(makeBatch(2, {
      writes: [{ kind: 'insert', model: MODEL, row: makeRow({ id: 'rejected', data: { attachment: { id: file().ref } } }) }],
      schedules: [{ op: 'replace', key: 'must-not-exist', at: 1, event: asOperation('Documents.due'), payload: {} }],
    })));
    assert.equal(await legacy.load(MODEL, asId('rejected')), null);
    assert.equal(await legacy.scheduleGet('must-not-exist'), null);
  });

  it('a writer that wins the revision fence invalidates the captured retirement census', async () => {
    const store = await backend.setup(); await install(store);
    const captured = request(await store.readRevision());
    await insert(store, { attachment: { id: file().ref } });
    const revision = await store.readRevision();
    await assert.rejects(() => store.retireFinalizedFile(captured), error => {
      assert.ok(error instanceof FenceConflictError); assert.equal(error.expected, 1); assert.equal(error.actual, 2); return true;
    });
    assert.equal(await store.readRevision(), revision);
    assert.equal(await store.readFinalizedFileRetirement(file().ref), null);
    assert.ok(await store.load(MODEL, asId('row')));
    await noEffects(store, () => store.retireFinalizedFile({ ...captured, expectedRevision: asRevision(2) }));
  });

  it('rejects publication of a previously staged retired reference atomically', async () => {
    const store = await backend.setup(); await install(store);
    const migrationId = 'staged-before-retirement', rows = [staged({ attachment: { id: file().ref } })];
    await store.stageMigrationRows({ expectedRevision: asRevision(1), migrationId, rows,
      progress: progress(migrationId, 2, 'staged') });
    await store.retireFinalizedFile(request(2));
    await noEffects(store, () => store.publishMigrationChunk({ expectedRevision: asRevision(3), migrationId, rows,
      history: [], drops: [], progress: progress(migrationId, 4, 'publishing'), fileReferenceInventory: inventory(false, true) }));
    assert.equal(await store.load(MODEL, asId('staged')), null);
    assert.equal((await store.readMigrationProgress(migrationId))?.phase, 'staged');
    assert.deepEqual(await store.readStagedRows(migrationId, null, 10), rows);
  });

  it('checks target correspondence and json-to-File reinterpretation before pointer idempotency', async () => {
    const store = await backend.setup(), old = inventory(true), target = inventory(false, true);
    await install(store, old); await insert(store, { attachment: { id: file().ref } });
    await store.retireFinalizedFile(request(2, old));
    const migrationId = 'reinterpret';
    await store.publishMigrationChunk({ expectedRevision: asRevision(3), migrationId, rows: [], history: [], drops: [],
      progress: progress(migrationId, 4, 'publishing'), fileReferenceInventory: target });
    const flip = { expectedRevision: asRevision(4), migrationId, owner: snapshot.owner,
      snapshot: { ...snapshot, ...identity(target) }, renameFromOwner: null, invalidatedIntentIds: [], outcomes: [] };
    await noEffects(store, () => store.flipInstalledSnapshot({ ...flip, fileReferenceInventory: target }));
    await noEffects(store, () => store.flipInstalledSnapshot({ ...flip, snapshot,
      fileReferenceInventory: { ...target, ...identity(old) } }));
    await noEffects(store, () => store.flipInstalledSnapshot({ ...flip,
      fileReferenceInventory: inventory(true, true) }));
    await noEffects(store, () => store.flipInstalledSnapshot({ ...flip,
      fileReferenceInventory: { ...target, artifactModels: [] } }));
    assert.equal((await store.readInstalledSnapshot(snapshot.owner))?.snapshotId, snapshot.snapshotId);
    assert.deepEqual((await store.load(MODEL, asId('row')))?.data, { attachment: { id: file().ref } });
  });

  it('refuses owner removal and installation that would leave live rows uncovered', async () => {
    const store = await backend.setup();
    await insert(store, {}, 'legacy');
    await noEffects(store, () => install(store, { ...inventory(), canonicalModels: [], artifactModels: [] }));
    assert.equal(await store.readFileReferenceInventory(snapshot.owner), null);
    await install(store);
    await noEffects(store, () => store.flipInstalledSnapshot({ expectedRevision: asRevision(2), migrationId: 'remove',
      owner: snapshot.owner, snapshot: null, renameFromOwner: null, invalidatedIntentIds: [], outcomes: [],
      fileReferenceInventory: null }));
    assert.ok(await store.readInstalledSnapshot(snapshot.owner));
    assert.ok(await store.load(MODEL, asId('legacy')));
  });

  it('publishes two target chunks, activates exact declarations and preserves the new installation facts on retry', async () => {
    const store = await backend.setup(), target = inventory(false, true);
    await install(store);
    const first = await insert(store, { attachment: { id: file().ref } }, 'first');
    const second = await insert(store, { attachment: { id: file().ref } }, 'second');
    const migrationId = 'complete-migration';
    const rows: StagedRow[] = [first, second].map((row, index) => ({ targetModel: MODEL,
      recordId: row.id, version: asVersion(2), data: { attachment: { id: `target-${index}` } },
      parent: null, converted: true, created: row.created, createdBy: row.createdBy, archivedAt: row.archivedAt }));
    await store.stageMigrationRows({ expectedRevision: asRevision(3), migrationId, rows,
      progress: progress(migrationId, 4, 'staged') });
    await store.publishMigrationChunk({ expectedRevision: asRevision(4), migrationId, rows: [rows[0]!],
      history: [], drops: [], progress: progress(migrationId, 5, 'publishing'), fileReferenceInventory: target });
    await noEffects(store, () => store.retireFinalizedFile(request(5)));
    await store.publishMigrationChunk({ expectedRevision: asRevision(5), migrationId, rows: [rows[1]!],
      history: [], drops: [], progress: progress(migrationId, 6, 'publishing'), fileReferenceInventory: target });
    const flip = { expectedRevision: asRevision(6), migrationId, owner: target.owner,
      snapshot: { ...snapshot, ...identity(target), installedAt: 777 }, renameFromOwner: null,
      invalidatedIntentIds: [], outcomes: [], fileReferenceInventory: target };
    assert.deepEqual(await store.flipInstalledSnapshot(flip), { flipped: true, revision: 7 });
    const installed = (await store.readFileReferenceInventory(target.owner))!;
    assert.equal(installed.snapshot.installedAt, 777); assert.equal(installed.snapshot.installedRevision, 7);
    assert.deepEqual(installed.inventory, target);
    assert.deepEqual(await store.flipInstalledSnapshot({ ...flip,
      snapshot: { ...flip.snapshot, installedRevision: asRevision(999), installedAt: 999 } }), { flipped: false, revision: 7 });
    assert.deepEqual(await store.readInstalledSnapshot(target.owner), installed.snapshot);
    const live = await store.query({ model: MODEL, authority: 'owner', order: [{ field: 'id', direction: 'asc' }] });
    assert.deepEqual(live.map(row => row.data), [{ attachment: { id: 'target-0' } }, { attachment: { id: 'target-1' } }]);
    const fact = await store.retireFinalizedFile(request(7, target));
    assert.deepEqual(fact.snapshot, installed.snapshot); assert.equal(fact.retiredRevision, 8);
  });

  it('allows unchanged expired occurrences through unrelated updates, but refuses removal followed by reintroduction', async () => {
    const store = await backend.setup(); await install(store);
    const original = await insert(store, { attachment: { id: file().ref }, label: 'before' });
    await store.retireFinalizedFile(request(2, inventory(), { disposition: 'expired', atMs: 1_500 }));
    const updated = { ...original, version: asVersion(2), data: { ...original.data, label: 'after' } };
    await store.commit(makeBatch(3, { writes: [{ kind: 'update', model: MODEL, id: original.id,
      expectedVersion: original.version, row: updated }] }));
    assert.deepEqual((await store.load(MODEL, original.id))?.data, updated.data);
    const removed = { ...updated, version: asVersion(3), data: { label: 'after' } };
    await store.commit(makeBatch(4, { writes: [{ kind: 'update', model: MODEL, id: original.id,
      expectedVersion: updated.version, row: removed }] }));
    await noEffects(store, () => store.commit(makeBatch(5, { writes: [{ kind: 'update', model: MODEL,
      id: original.id, expectedVersion: removed.version,
      row: { ...removed, version: asVersion(4), data: updated.data } }] })));
    assert.deepEqual((await store.load(MODEL, original.id))?.data, removed.data);
    assert.ok(await store.readFinalizedFileRetirement(file().ref));
  });

  it('refuses unknown model writes and a foreign binding after reopening the same persisted store', async () => {
    let store = await backend.setup(); await install(store);
    await noEffects(store, () => store.commit(makeBatch(1, { writes: [{ kind: 'insert',
      model: asModel('Foreign.Record'), row: makeRow({ id: 'foreign', data: {} }) }] })));
    assert.equal(await store.load(asModel('Foreign.Record'), asId('foreign')), null);
    await assert.rejects(async () => {
      const foreign = await backend.reopen(store, { ...authority, stateStoreId: 'foreign-state' });
      await foreign.readRevision();
    }, error => error instanceof StorageConstraintError && error.kind === 'reference');
    store = await backend.reopen(store, true) as FileReferenceStoragePort;
    assert.equal(await store.readRevision(), 1);
    assert.deepEqual((await store.readFileReferenceInventory(snapshot.owner))?.authority, authority);
  });

  if (backend.name !== 'memory') it('arbitrates simultaneous retirement and writer admission with one atomic revision winner', async () => {
    const store = await backend.setup(); await install(store);
    const writer = makeBatch(1, {
      writes: [{ kind: 'insert', model: MODEL, row: makeRow({ id: 'racing', data: { attachment: { id: file().ref } } }) }],
      schedules: [{ op: 'replace', key: 'race-effect', at: 1, event: asOperation('Documents.due'), payload: {} }],
    });
    const outcomes = await Promise.allSettled([store.commit(writer), store.retireFinalizedFile(request(1))]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    const loser = outcomes.find(outcome => outcome.status === 'rejected'); assert.ok(loser);
    assert.ok(loser.reason instanceof FenceConflictError);
    assert.equal(loser.reason.expected, 1); assert.equal(loser.reason.actual, 2);
    assert.equal(await store.readRevision(), 2);
    if (outcomes[0]!.status === 'fulfilled') {
      assert.ok(await store.load(MODEL, asId('racing'))); assert.ok(await store.scheduleGet('race-effect'));
      assert.equal(await store.readFinalizedFileRetirement(file().ref), null);
      await noEffects(store, () => store.retireFinalizedFile(request(2)));
    } else {
      assert.equal(await store.load(MODEL, asId('racing')), null); assert.equal(await store.scheduleGet('race-effect'), null);
      assert.ok(await store.readFinalizedFileRetirement(file().ref));
      const legacy = await backend.reopen(store, false);
      await noEffects(legacy, () => legacy.commit({ ...writer, expectedRevision: asRevision(2) }));
      assert.equal(await legacy.load(MODEL, asId('racing')), null); assert.equal(await legacy.scheduleGet('race-effect'), null);
    }
  });
});

describe('actual DO framework File admission', () => {
  const declarations = () => ({ ...inventory(), frameworkModels: STATE_FILE_REFERENCE_PRODUCER.models });
  async function setupFramework(): Promise<FileReferenceStoragePort> {
    await backends.find(backend => backend.name === 'do')!.setup();
    await doPost('/reopen', { authority, framework: 'state' });
    const store = doProxy(); await install(store, declarations()); return store;
  }
  it('joins real State controls and domain File census, reopens the actual issuer, and guards legacy writes', async () => {
    const store = await setupFramework(), meta = { nowMs: 100, actor: 'alice' };
    const association = newAssociationRow({ recordModel: MODEL, recordId: 'row', field: 'delivery',
      deliveryId: 'delivery', source: 'Documents.send', revision: 0 }, meta);
    const scan = stageFanoutOwnerScanWrite({ owner: 'team', row: null, visitedIntentRow: null, meta });
    assert.equal(scan.kind, 'insert');
    if (scan.kind !== 'insert') throw new Error('expected owning scan insert');
    await store.commit(makeBatch(1, { writes: [
      { kind: 'insert', model: MODEL, row: makeRow({ id: 'row', data: { attachment: { id: 'shared' } } }) },
      { kind: 'insert', model: asModel(RECEIPT_ASSOCIATION_MODEL), row: association }, scan,
    ] }));
    await noEffects(store, () => store.retireFinalizedFile(request(2, declarations(), { file: file('shared') })));
    const fact = await store.retireFinalizedFile(request(2, declarations()));
    await doPost('/reopen', { authority });
    await assert.rejects(() => doProxy().readFileReferenceInventory(snapshot.owner));
    await doPost('/reopen', {});
    await noEffects(doProxy(), () => doProxy().commit(makeBatch(3, { writes: [{ kind: 'insert', model: MODEL,
      row: makeRow({ id: 'missing-bound', data: {} }) }], schedules: [{ op: 'replace', key: 'missing-bound', at: 1,
      event: asOperation('Documents.due'), payload: {} }] })));
    await doPost('/reopen', { authority, framework: 'state' });
    assert.deepEqual(await store.readFinalizedFileRetirement(file().ref), fact);
    assert.deepEqual(await store.retireFinalizedFile(request(2, declarations(), { atMs: 99_999 })), fact);
    assert.equal(await store.load(MODEL, asId('missing-bound')), null);
    assert.equal(await store.scheduleGet('missing-bound'), null);
    assert.ok(await store.load(asModel(FANOUT_OWNER_SCAN_MODEL), scan.row.id));
    assert.equal(await store.readRevision(), 3);
  });
  it('rolls back actual SQL effects for owning opaque receipts, unknown fields and target correspondence drift', async () => {
    const store = await setupFramework();
    const receipt = newReceiptRow({ deliveryId: 'opaque', revision: 0, status: 'succeeded', result: { id: file().ref },
      error: null, contentRef: null, resultExpiresAtMs: null }, { nowMs: 100, actor: 'alice' });
    STATE_FILE_REFERENCE_PRODUCER.validateRow(asModel(RECEIPT_MODEL), receipt);
    const scan = stageFanoutOwnerScanWrite({ owner: 'team', row: null, visitedIntentRow: null,
      meta: { nowMs: 100, actor: 'alice' } });
    assert.equal(scan.kind, 'insert');
    if (scan.kind !== 'insert') throw new Error('expected owning scan insert');
    for (const write of [ { kind: 'insert' as const, model: asModel(RECEIPT_MODEL), row: receipt },
      { ...scan, row: { ...scan.row, data: { ...scan.row.data, unknown: 'extra' } } } ]) {
      await noEffects(store, () => store.commit(makeBatch(1, { writes: [write], schedules: [{ op: 'replace',
        key: 'rollback', at: 1, event: asOperation('Documents.due'), payload: {} }] })));
      assert.equal(await store.load(write.model, write.row.id), null);
      assert.equal(await store.scheduleGet('rollback'), null);
    }
    await store.commit(makeBatch(1, { writes: [scan] }));
    const target = { ...declarations(), snapshotId: 'target', digest: 'target' }, migrationId = 'framework-target';
    const staged = { targetModel: scan.model, recordId: scan.row.id, version: asVersion(2), data: scan.row.data,
      parent: null, converted: true, created: scan.row.created, createdBy: scan.row.createdBy };
    await store.stageMigrationRows({ expectedRevision: asRevision(2), migrationId, rows: [staged],
      progress: progress(migrationId, 3, 'staged') });
    const publish = { expectedRevision: asRevision(3), migrationId, rows: [staged], history: [], drops: [],
      progress: progress(migrationId, 4, 'publishing') };
    await noEffects(store, () => store.publishMigrationChunk({ ...publish,
      fileReferenceInventory: { ...target, frameworkModels: [] } }));
    await store.publishMigrationChunk({ ...publish, fileReferenceInventory: target });
    const flip = { expectedRevision: asRevision(4), migrationId, owner: snapshot.owner,
      snapshot: { ...snapshot, snapshotId: 'target', digest: 'target' }, renameFromOwner: null,
      invalidatedIntentIds: [], outcomes: [], fileReferenceInventory: target };
    await noEffects(store, () => store.flipInstalledSnapshot({ ...flip,
      fileReferenceInventory: { ...target, frameworkModels: [] } }));
    assert.deepEqual(await store.flipInstalledSnapshot(flip), { flipped: true, revision: 5 });
    assert.deepEqual((await store.readFileReferenceInventory(snapshot.owner))?.inventory, target);
  });
});

/** Full compiled original closure; these cases qualify the actual DO stored
 * consumer, not source-verified native dispatch or current File disclosure. */
interface DOReceiptSource {
  inventory: FileReferenceInventory;
  model: ModelName;
  origin: Extract<FrameworkFilePayloadOrigin['origin'], { kind: 'delivery-result' }>;
}
function originalDOContractDefaults(artifact: CompileArtifact): {
  originalContracts: Readonly<Record<string, WireValue>>;
  valueDefaults: readonly FrameworkOpaqueValueDefault[];
} {
  // Nominal artifact leaves erase defaults. Capture the actual native literal
  // before normalization, without evaluating the application's executable code.
  const expressions: string[] = [];
  for (const module of artifact.modules) {
    const parsed = ts.createSourceFile(module.path, module.js, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    for (const statement of parsed.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'appDefinition') continue;
        assert.ok(declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer),
          'original appDefinition must retain its native schema object');
        const contracts = declaration.initializer.properties.find(property => ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'contracts');
        assert.ok(contracts && ts.isPropertyAssignment(contracts) && ts.isObjectLiteralExpression(contracts.initializer),
          'original native contract schema is required; omitted metadata does not mean no defaults');
        expressions.push(contracts.initializer.getText(parsed));
      }
    }
  }
  assert.equal(expressions.length, 1, 'one complete owning native contract schema');
  function ownMetadata(value: unknown): Record<string, unknown> {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'original metadata must be a record');
    const prototype = Object.getPrototypeOf(value);
    assert.ok(prototype === null || Object.getPrototypeOf(prototype) === null, 'original metadata must have a plain prototype');
    return Object.fromEntries(Reflect.ownKeys(value).map(key => {
      assert.equal(typeof key, 'string', 'original metadata has no symbol fields');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      assert.ok(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'original metadata requires own data descriptors');
      return [key, descriptor.value];
    }));
  }
  function detachMetadata(value: unknown, nativeDefault = false): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return nativeDefault ? value : encodeValue('int', value);
    if (typeof value === 'number') { assert.ok(Number.isFinite(value)); return value; }
    if (Array.isArray(value)) {
      assert.equal(Reflect.ownKeys(value).length, value.length + 1, 'original metadata arrays must be dense without extra properties');
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        assert.ok(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), 'original metadata array requires own data');
        return detachMetadata(descriptor.value, nativeDefault);
      });
    }
    return Object.fromEntries(Object.entries(ownMetadata(value)).map(([name, item]) => [name, detachMetadata(item, nativeDefault)]));
  }
  const detachWire = (value: unknown): WireValue => detachMetadata(value) as WireValue;
  const raw: unknown = runInNewContext(`(${expressions[0]})`, Object.create(null), { timeout: 1_000 });
  const contracts = ownMetadata(raw);
  assert.ok(artifact.valueTypes, 'complete original nominal inventory must accompany the native schema');
  assert.deepEqual(Object.keys(contracts).sort(), artifact.valueTypes.contracts.map(contract => contract.name).sort(),
    'native schema and artifact must retain the same complete contract closure');
  const defaults: FrameworkOpaqueValueDefault[] = [], originalContracts: Record<string, WireValue> = {};
  for (const contract of artifact.valueTypes.contracts) {
    const originalContract = ownMetadata(contracts[contract.name]);
    const fields = ownMetadata(originalContract['fields']);
    assert.deepEqual(Object.keys(fields).sort(), contract.fields.map(field => field.name).sort(),
      `original native fields are complete for ${contract.name}`);
    for (const field of contract.fields) {
      const original = ownMetadata(fields[field.name]);
      assert.equal(original['type'], field.type);
      if (Object.hasOwn(original, 'default')) {
        assert.notEqual(typeof original['default'], 'function', 'only original literal defaults supply retained wire facts');
        const value = detachWire(encodeValue(field.type, detachMetadata(original['default'], true) as CanValue));
        defaults.push({ contract: contract.name, field: field.name, value });
        original['default'] = value;
      }
      fields[field.name] = detachWire(original);
    }
    originalContracts[contract.name] = detachWire({ ...originalContract, fields });
  }
  return { originalContracts, valueDefaults: defaults };
}
function compileDOReceiptSource(): DOReceiptSource {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const binary = [process.env.CAN_COMPILER, join(root, 'compiler/target/debug/can'),
    join(root, 'compiler/target/release/can'), join(root, 'target/debug/can')]
    .find(path => path !== undefined && existsSync(path));
  assert.ok(binary, 'actual DO opaque census requires the Can compiler');
  const dir = mkdtempSync(join(tmpdir(), 'can-do-receipt-source-'));
  try {
    const input = join(dir, 'bound-images.can');
    writeFileSync(input, readFileSync(join(root, 'packages/cloudflare/test/fixtures/typed-images-progress.can'), 'utf8')
      .replace('app TypedImagesProgress', 'app Documents'));
    const environment = { ...process.env }; delete environment.CAN_CATALOG;
    const artifact = JSON.parse(execFileSync(binary, ['compile', '--format=json', '--catalog',
      join(root, 'packages/values/dist/catalog.json'), input], { encoding: 'utf8', env: environment })) as CompileArtifact;
    const { originalContracts, valueDefaults } = originalDOContractDefaults(artifact);
    const loaded = loadArtifactDescriptors(artifact, { by: 'members' });
    const callable = artifact.callables.find(item => item.id === 'Documents.generate');
    const authored = artifact.operations?.find(item => item.name === 'Documents.generate');
    const operation = loaded.registry.get(asOperation('Documents.generate'));
    assert.ok(operation && isGeneratedOperationDef(operation), 'compiled generate must supply its actual generated descriptor');
    const canonical = operation.descriptor;
    const model = asModel('Documents.Job');
    const field = artifact.models?.find(item => item.name === model)?.fields.find(item => item.name === 'request');
    const source = artifact.sources.find(item => item.path === input || item.path.endsWith('bound-images.can'));
    assert.ok(callable && authored && canonical && field && source && loaded.valueTypes);
    if (field.field.kind !== 'delivery' || 'judgment' in field.field) throw new Error('actual Images delivery declaration required');
    assert.equal(field.field.result.name, 'ImageRun');
    assert.ok(field.field.result.fields.some(leaf => leaf.name === 'outputs' && leaf.type === 'GeneratedImage[]'));
    assert.deepEqual(authored.result, { type: 'void' });
    assert.deepEqual(canonical.result, { type: 'void' });
    const originalSource = { ...source, module: callable.module };
    const declaration: FrameworkOpaqueDeliveryContext = { kind: 'generation', canonical: field.field,
      artifact: field.field, request: { source: 'bound-job', revision: '0' } };
    const original = { owner: snapshot.owner, snapshotId: 'do-original', digest: `sha256:${source.sha256}` };
    const callerSource = { kind: 'callable' as const, source: originalSource, callable };
    const set: FrameworkOpaqueDeclarationSet = { id: 'do/original', inventory: original,
      snapshot: { ...original, installedAt: snapshot.installedAt, installedRevision: asRevision(1) },
      sources: artifact.sources, canonicalModels: loaded.models, artifactModels: artifact.models!, valueTypes: loaded.valueTypes!, originalContracts, valueDefaults,
      declarations: [
        { id: 'do/generate/inputs', source: callerSource,
          profile: { kind: 'inputs', canonical: canonical.inputs, artifact: authored.inputs.fields } },
        { id: 'do/generate/void', source: callerSource,
          profile: { kind: 'void', canonical: { type: 'void' }, artifact: { type: 'void' } } },
        { id: 'do/images/result', source: { kind: 'delivery', source: originalSource, context: declaration },
          profile: { kind: 'provider-result', canonical: field.field.result, artifact: field.field.result } },
      ] };
    return { model, inventory: { ...original, canonicalModels: loaded.models, artifactModels: artifact.models!,
      valueTypes: loaded.valueTypes!, frameworkModels: STATE_FILE_REFERENCE_PRODUCER.models, opaqueDeclarationSets: [set] },
      origin: { kind: 'delivery-result', deliveryId: 'bound-delivery',
        intent: { intentId: 'bound-delivery', operation: canonical.name,
          operationId: asOperationId('bound-operation'), target: 'std.ImagesV1.submit', occurrenceIndex: 0 },
        request: { binding: 'Documents.Images', from: 'deployment.comfyui' },
        caller: { source: originalSource, callable, canonical, artifact: authored, resultDeclarationId: 'do/generate/void' },
        association: { model, recordId: asId('bound-job'), field: 'request' }, declaration, resultDeclarationId: 'do/images/result' } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('actual DO source-bound opaque receipt census', () => {
  let compiled: DOReceiptSource;
  before(() => { compiled = compileDOReceiptSource(); });
  const meta = { nowMs: 100, actor: 'alice' };
  function result(ref: string | null, sequence = '1') {
    return { source: 'bound-job', revision: '0', sequence, state: 'succeeded',
      outputs: ref === null ? [] : [{ position: '0', image: { id: ref } }], charged_jobs: '1', detail: null };
  }
  async function world() {
    await backends.find(backend => backend.name === 'do')!.setup();
    await doPost('/reopen', { authority, framework: 'state' });
    const store = doProxy(), declarations = structuredClone(compiled.inventory), origin = structuredClone(compiled.origin);
    await install(store, declarations);
    const installed = (await store.readFileReferenceInventory(declarations.owner))!;
    assert.deepEqual(installed.snapshot, declarations.opaqueDeclarationSets![0]!.snapshot);
    const facts = (await doPost('/finalize-provider', { origin, receiver: { ...authority.receiver, principal: 'alice' },
      retention, atMs: 1_000 }))['value'] as RetainedFinalizedFile;
    const { retention: _retention, ...finalized } = facts;
    const context = { source: origin.intent.target, declaredResult: origin.declaration.canonical.result,
      request: { source: 'bound-job', revision: '0' } };
    const row = newReceiptRow({ deliveryId: origin.deliveryId, revision: 1, status: 'succeeded', result: result(facts.ref),
      error: null, contentRef: null, resultExpiresAtMs: null }, meta, context);
    const originInput = { expectedRevision: asRevision(1), inventoryOwner: declarations.owner, declarationSetId: 'do/original',
      model: asModel(RECEIPT_MODEL), row, field: 'result',
      scope: { app: authority.app, ownerPackage: snapshot.owner, owner: authority.receiver.owner }, origin };
    const binding = (await doPost('/prepare-origin', { input: originInput,
      files: [{ path: ['outputs', 0, 'image'], ref: facts.ref }] }))['value'] as FrameworkFilePayloadOrigin;
    const terminal = { ...row, data: { ...row.data, filePayloadOrigin: binding } };
    const association = newAssociationRow({ recordModel: compiled.model, recordId: 'bound-job', field: 'request',
      deliveryId: origin.deliveryId, source: origin.intent.target, revision: 1 }, meta);
    const record = { ...makeRow({ id: 'bound-job', created: meta.nowMs, updated: meta.nowMs,
      data: { label: 'Images', revision: '0', request: { id: origin.deliveryId, operation: origin.intent.target },
        cancellation: null, reconciliation: null } }), parent: null };
    const writes = [{ kind: 'insert' as const, model: compiled.model, row: record },
      { kind: 'insert' as const, model: asModel(RECEIPT_ASSOCIATION_MODEL), row: association },
      { kind: 'insert' as const, model: asModel(RECEIPT_MODEL), row: terminal }];
    const retirement = (disposition: 'orphaned' | 'expired', atMs: number): RetireFinalizedFile => ({
      expectedRevision: asRevision(2), inventory: identity(declarations), file: finalized, disposition,
      retention, atMs, maxRows: 30, maxReferences: 100 });
    return { store, declarations, origin, facts, context, terminal, binding, originInput, writes, retirement };
  }
  async function rejectedUpdate(store: FileReferenceStoragePort, original: StoredRow, replacement: StoredRow) {
    await noEffects(store, async () => store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update',
      model: asModel(RECEIPT_MODEL), id: original.id, expectedVersion: original.version, row: replacement }],
      schedules: [{ op: 'replace', key: 'opaque-rollback', at: 1, event: asOperation('Documents.due'), payload: {} }] })));
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), original.id), original);
    assert.equal(await store.scheduleGet('opaque-rollback'), null);
  }
  it('counts a real finalized result across SQLite reopening and preserves only unchanged expired positions', async () => {
    const w = await world(), store = w.store;
    await store.commit(makeBatch(1, { writes: w.writes }));
    await noEffects(store, () => store.retireFinalizedFile(w.retirement('orphaned', 1_100)));
    assert.equal(await store.readFinalizedFileRetirement(w.facts.ref), null);
    await doPost('/reopen', { authority, framework: 'state' });
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), w.terminal.id), w.terminal);
    await noEffects(store, () => store.retireFinalizedFile({ ...w.retirement('expired', 1_500), maxRows: 2 }));
    const retired = await store.retireFinalizedFile(w.retirement('expired', 1_500));
    assert.equal(retired.censusRevision, 2);
    assert.equal(retired.file.ref, w.facts.ref);
    const keep = { ...w.terminal, version: asVersion(2), archivedAt: 1_500, updated: 1_500,
      data: { ...w.terminal.data, result: result(w.facts.ref, '2') } };
    await store.commit(makeBatch(3, { writes: [{ kind: 'update', model: asModel(RECEIPT_MODEL), id: keep.id,
      expectedVersion: w.terminal.version, row: keep }] }));
    const movedBinding = structuredClone(w.binding);
    Object.assign(movedBinding, { files: [movedBinding.files[0]!,
      { path: ['outputs', 1, 'image'], file: movedBinding.files[0]!.file }] });
    const moved = { ...keep, version: asVersion(3), data: { ...keep.data, filePayloadOrigin: movedBinding,
      result: { ...result(w.facts.ref), outputs: [{ position: '0', image: { id: w.facts.ref } },
        { position: '1', image: { id: w.facts.ref } }] } } };
    await rejectedUpdate(store, keep, moved);
    const empty = withReceiptRowData(keep, { deliveryId: w.origin.deliveryId, revision: 2, status: 'succeeded',
      result: result(null, '2'), error: null, contentRef: null, resultExpiresAtMs: null,
      filePayloadOrigin: { ...w.binding, files: [] } }, { ...meta, nowMs: 1_500 }, w.context);
    await store.commit(makeBatch(4, { writes: [{ kind: 'update', model: asModel(RECEIPT_MODEL), id: empty.id,
      expectedVersion: keep.version, row: empty }] }));
    const reintroduced = { ...empty, version: asVersion(empty.version + 1),
      data: { ...empty.data, result: result(w.facts.ref, '3'), filePayloadOrigin: w.binding } };
    await rejectedUpdate(store, empty, reintroduced);
    await doPost('/reopen', { authority, framework: 'state' });
    assert.deepEqual(await store.readFinalizedFileRetirement(w.facts.ref), retired);
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), empty.id), empty);
    assert.equal(await store.readRevision(), 5);
  });
  it('refuses missing or mismatched original source bindings, complete profiles and receiving facts without SQL effects', async () => {
    const w = await world(), store = w.store;
    for (const files of [[], [{ path: ['outputs', 0, 'image', 'id'], ref: w.facts.ref }],
      [{ path: ['outputs', 0, 'image'], ref: 'unknown-observation' }],
      [{ path: ['outputs', 0, 'image'], ref: w.facts.ref }, { path: ['outputs', 0, 'image'], ref: w.facts.ref }]]) {
      await noEffects(store, () => doPost('/prepare-origin', { input: w.originInput, files }));
    }
    await noEffects(store, () => doPost('/prepare-origin', { input: { ...w.originInput,
      origin: { ...w.origin, resultDeclarationId: 'missing/result' } },
      files: [{ path: ['outputs', 0, 'image'], ref: w.facts.ref }] }));
    const withoutBinding = { ...w.terminal, data: { ...w.terminal.data } };
    Reflect.deleteProperty(withoutBinding.data, 'filePayloadOrigin');
    const badSource = structuredClone(w.binding);
    if (badSource.origin.kind !== 'delivery-result') throw new Error('expected delivery result');
    Object.assign(badSource.origin.caller.source, { sha256: 'f'.repeat(64) });
    const badFacts = structuredClone(w.binding);
    Object.assign(badFacts.files[0]!.file, { bytesDigest: 'renewed-digest' });
    for (const row of [withoutBinding, { ...w.terminal, data: { ...w.terminal.data, filePayloadOrigin: { ...w.binding, files: [] } } },
      { ...w.terminal, data: { ...w.terminal.data, filePayloadOrigin: badSource } },
      { ...w.terminal, data: { ...w.terminal.data, filePayloadOrigin: { ...w.binding, declarationSetId: 'missing/original' } } }]) {
      await noEffects(store, () => store.commit(makeBatch(1, { writes: [{ kind: 'insert', model: asModel(RECEIPT_MODEL), row }],
        schedules: [{ op: 'replace', key: 'opaque-rollback', at: 1, event: asOperation('Documents.due'), payload: {} }] })));
      assert.equal(await store.load(asModel(RECEIPT_MODEL), row.id), null);
      assert.equal(await store.scheduleGet('opaque-rollback'), null);
    }
    await store.commit(makeBatch(1, { writes: w.writes }));
    for (const binding of [badFacts, badSource]) await rejectedUpdate(store, w.terminal,
      { ...w.terminal, version: asVersion(2), data: { ...w.terminal.data, filePayloadOrigin: binding } });
    type OriginalContracts = Record<string, { fields: Record<string, Record<string, WireValue>> }>;
    const originalContracts = w.declarations.opaqueDeclarationSets![0]!.originalContracts as unknown as OriginalContracts;
    const originals = Object.entries(originalContracts).flatMap(([contract, definition]) =>
      Object.entries(definition.fields).map(([field, metadata]) => ({ contract, field, metadata })));
    const noDefault = originals.find(item => item.metadata['type'] === 'text' && !Object.hasOwn(item.metadata, 'default'));
    const integerBound = (value: unknown): value is number | string =>
      typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value);
    const constrained = originals.find(item => integerBound(item.metadata['max']) || integerBound(item.metadata['min'])) ?? noDefault;
    assert.ok(noDefault, 'the complete original source must retain a text field with no own default');
    assert.ok(constrained, 'an actual original field must own the constraint-drift control');
    function rawMutation(change: (contracts: OriginalContracts) => void): FileReferenceInventory {
      const changed = structuredClone(w.declarations);
      change(changed.opaqueDeclarationSets![0]!.originalContracts as unknown as OriginalContracts);
      return changed;
    }
    const absentRaw = structuredClone(w.declarations);
    Reflect.deleteProperty(absentRaw.opaqueDeclarationSets![0]!, 'originalContracts');
    const rawDrift = [absentRaw,
      rawMutation(contracts => { Reflect.deleteProperty(contracts, noDefault.contract); }),
      rawMutation(contracts => { contracts['test.extra_original_contract'] = structuredClone(contracts[noDefault.contract]!); }),
      rawMutation(contracts => { Reflect.deleteProperty(contracts[noDefault.contract]!.fields, noDefault.field); }),
      rawMutation(contracts => { contracts[noDefault.contract]!.fields['extra_original_field'] = { type: 'text' }; }),
      rawMutation(contracts => { contracts[noDefault.contract]!.fields[noDefault.field]!['type'] = 'bool'; }),
      rawMutation(contracts => {
        const metadata = contracts[constrained.contract]!.fields[constrained.field]!;
        const key = integerBound(metadata['max']) ? 'max' : integerBound(metadata['min']) ? 'min' : 'max';
        const original = metadata[key];
        // This complete Images source has no authored numeric bound in its
        // native map: adding one is also source/constraint correspondence drift.
        metadata[key] = typeof original === 'string' && integerBound(original) ? encodeValue('int', BigInt(original) + 1n) :
          typeof original === 'number' && integerBound(original) ? original + 1 : encodeValue('int', 1n);
      }),
      rawMutation(contracts => { contracts[noDefault.contract]!.fields[noDefault.field]!['default'] = ''; }),
    ];
    for (const declarations of [{ ...w.declarations, opaqueDeclarationSets: [] },
      { ...w.declarations, opaqueDeclarationSets: [{ ...w.declarations.opaqueDeclarationSets![0]!, sources: [] }] },
      { ...w.declarations, opaqueDeclarationSets: [{ ...w.declarations.opaqueDeclarationSets![0]!, declarations: [] }] }, ...rawDrift]) {
      await noEffects(store, () => store.installFileReferenceInventory({ expectedRevision: asRevision(2), authority,
        snapshot: { ...snapshot, ...identity(declarations) }, inventory: declarations }));
      assert.deepEqual(await store.readFileReferenceInventory(snapshot.owner), {
        authority, snapshot: w.declarations.opaqueDeclarationSets![0]!.snapshot, inventory: w.declarations });
    }
    // Removal happens before the original File expiry. Saved header facts here
    // test independent durable admission; copying them supplies no observation,
    // native loader evidence, disclosure permission or renewed File authority.
    const empty = withReceiptRowData(w.terminal, { deliveryId: w.origin.deliveryId, revision: 2, status: 'succeeded',
      result: result(null, '2'), error: null, contentRef: null, resultExpiresAtMs: null,
      filePayloadOrigin: { ...w.binding, files: [] } }, { ...meta, nowMs: 1_200 }, w.context);
    await store.commit(makeBatch(2, { writes: [{ kind: 'update', model: asModel(RECEIPT_MODEL), id: empty.id,
      expectedVersion: w.terminal.version, row: empty }] }));
    await doPost('/reopen', { authority, framework: 'state' });
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), empty.id), empty);
    assert.equal(await store.readFinalizedFileRetirement(w.facts.ref), null);
    const renewed = structuredClone(w.binding);
    Object.assign(renewed.files[0]!.file.retention, { retentionMs: retention.retentionMs + 1 });
    const reintroduce = (binding: FrameworkFilePayloadOrigin) => withReceiptRowData(empty, {
      deliveryId: w.origin.deliveryId, revision: 3, status: 'succeeded', result: result(w.facts.ref, '3'),
      error: null, contentRef: null, resultExpiresAtMs: null, filePayloadOrigin: binding,
    }, { ...meta, nowMs: 1_200 }, w.context);
    await rejectedUpdate(store, empty, reintroduce(renewed));
    assert.equal(await store.readRevision(), 3, 'renewal must lose at the same captured fence');
    const originalFacts = reintroduce(w.binding);
    await store.commit(makeBatch(3, { writes: [{ kind: 'update', model: asModel(RECEIPT_MODEL), id: empty.id,
      expectedVersion: empty.version, row: originalFacts }] }));
    assert.deepEqual(await store.load(asModel(RECEIPT_MODEL), empty.id), originalFacts);
    assert.equal(await store.readRevision(), 4);
    assert.equal(await store.readFinalizedFileRetirement(w.facts.ref), null);
  });
});

describe('protected Memory migration engine integration', () => {
  const clock = { nowMs: () => 888 };
  function enginePlan(installed: InstalledSnapshot, old: FileReferenceInventory, target: FileReferenceInventory,
    migrationId: string) {
    const table = (declarations: FileReferenceInventory) => buildModelTableFromCanonical(declarations.canonicalModels,
      { valueSchema: normalizeValueTypes(declarations.valueTypes, declarations.canonicalModels.map(model => model.name)).valueSchema });
    const oldModels = table(old), desiredModels = table(target);
    const plan = validateTransition(installed, { migrationId, owner: installed.owner,
      fromSnapshotId: installed.snapshotId, fromDigest: installed.digest,
      toSnapshotId: target.snapshotId, toDigest: target.digest, bodyDigest: 'engine-body', directives: [] },
    oldModels, desiredModels);
    return { plan, oldModels, desiredModels };
  }
  it('activate forwards exact target declarations for staged rows and an empty collection', async () => {
    for (const empty of [false, true]) {
      const store = createTestMemoryStorage(authority).store, old = inventory(), target = inventory(false, true);
      await install(store, old);
      const rows: StagedRow[] = [];
      if (!empty) {
        const row = await insert(store, { attachment: { id: 'engine-current' } });
        rows.push({ targetModel: MODEL, recordId: row.id, version: row.version, data: row.data,
          parent: null, converted: false, created: row.created, createdBy: row.createdBy, archivedAt: row.archivedAt });
      }
      const migrationId = empty ? 'engine-empty' : 'engine-row';
      const installed = (await store.readInstalledSnapshot(old.owner))!;
      const engine = enginePlan(installed, old, target, migrationId);
      const revision = await store.readRevision();
      await store.stageMigrationRows({ expectedRevision: revision, migrationId, rows,
        progress: progress(migrationId, revision + 1, 'staged') });
      const result = await activate({ store, ...engine, inventory: [], chunkSize: 1, clock,
        fileReferenceInventory: target });
      assert.equal(result.flipped, true);
      const installedTarget = (await store.readFileReferenceInventory(target.owner))!;
      assert.deepEqual(installedTarget.inventory, target);
      assert.equal(installedTarget.snapshot.installedRevision, result.revision);
      assert.equal(installedTarget.snapshot.installedAt, 888);
      assert.equal((await store.readMigrationProgress(migrationId))?.phase, 'active');
      assert.equal((await store.query({ model: MODEL, authority: 'owner' })).length, empty ? 0 : 1);
      const fact = await store.retireFinalizedFile(request(result.revision, target));
      assert.deepEqual(fact.snapshot, installedTarget.snapshot);
    }
  });

  it('resumeMigration continues an interrupted protected publication with the same target declarations', async () => {
    const store = createTestMemoryStorage(authority).store, old = inventory(), target = inventory(false, true);
    await install(store, old);
    const first = await insert(store, { attachment: { id: 'engine-first' } }, 'first');
    const second = await insert(store, { attachment: { id: 'engine-second' } }, 'second');
    const migrationId = 'engine-resume', engine = enginePlan((await store.readInstalledSnapshot(old.owner))!, old, target, migrationId);
    const rows: StagedRow[] = [first, second].map(row => ({ targetModel: MODEL, recordId: row.id,
      version: row.version, data: row.data, parent: null, converted: false,
      created: row.created, createdBy: row.createdBy, archivedAt: row.archivedAt }));
    await store.stageMigrationRows({ expectedRevision: asRevision(3), migrationId, rows,
      progress: progress(migrationId, 4, 'staged') });
    await store.publishMigrationChunk({ expectedRevision: asRevision(4), migrationId, rows: [rows[0]!],
      history: [], drops: [], fileReferenceInventory: target,
      progress: { ...progress(migrationId, 5, 'publishing'), publishCursor: { model: MODEL, recordId: first.id } } });
    const resumed = await resumeMigration({ store, ...engine, mappers: new Map(), oldLocks: new Map(),
      inventory: [], chunkSize: 1, clock, fileReferenceInventory: target });
    assert.equal(resumed.flip?.flipped, true); assert.equal(resumed.progress?.phase, 'active');
    assert.deepEqual((await store.readFileReferenceInventory(target.owner))?.inventory, target);
    assert.deepEqual((await store.query({ model: MODEL, authority: 'owner', order: [{ field: 'id', direction: 'asc' }] }))
      .map(row => row.data), [first.data, second.data]);
    assert.equal((await store.readInstalledSnapshot(target.owner))?.installedAt, 888);
  });

  it('rejects accessor reentry in commit and flip without invoking accessors or changing guard state', async () => {
    const store = createTestMemoryStorage(authority).store; await install(store);
    let commitReads = 0, flipReads = 0;
    const batch = makeBatch(1, { schedules: [{ op: 'replace', key: 'accessor-effect', at: 1,
      event: asOperation('Documents.due'), payload: {} }] });
    Object.defineProperty(batch, 'outboxAck', { enumerable: true, get() {
      commitReads += 1; void store.retireFinalizedFile(request(1)); return [];
    } });
    await noEffects(store, () => store.commit(batch));
    assert.equal(commitReads, 0); assert.equal(await store.scheduleGet('accessor-effect'), null);
    assert.equal(await store.readFinalizedFileRetirement(file().ref), null);
    const before = await store.readFileReferenceInventory(snapshot.owner);
    const flip = { expectedRevision: asRevision(1), migrationId: 'accessor-flip', owner: snapshot.owner,
      snapshot, renameFromOwner: null, invalidatedIntentIds: [], outcomes: [], fileReferenceInventory: inventory() };
    Object.defineProperty(flip, 'snapshot', { enumerable: true, get() { flipReads += 1; return snapshot; } });
    await noEffects(store, () => store.flipInstalledSnapshot(flip));
    assert.equal(flipReads, 0);
    assert.deepEqual(await store.readFileReferenceInventory(snapshot.owner), before);
    assert.deepEqual(await store.readInstalledSnapshot(snapshot.owner), before?.snapshot);
  });
});
