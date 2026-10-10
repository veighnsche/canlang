/** Authoritative File admission conformance against the actual memory, D1
 * (Miniflare) and Durable Object SQLite (workerd) adapters. The DO proxy only
 * transports calls: all census, admission and atomic writes execute in workerd. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { ArtifactModel, CanTypeId, FileReferenceInventory, FileReferenceStoragePort,
  FileRetirementAuthority, FinalizedFileIdentity, InstalledSnapshot, MigrationProgress,
  RetireFinalizedFile, StagedRow, StoragePort } from '@canlang/contracts';
import { createTestMemoryStorage } from '../src/storage/memory.js';
import { STATE_FILE_REFERENCE_PRODUCER } from '../src/storage/index.js';
import { newAssociationRow, newReceiptRow, RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL } from '../src/receipt/tables.js';
import { stageFanoutOwnerScanWrite, FANOUT_OWNER_SCAN_MODEL } from '../src/fanout/navigation.js';
import { FenceConflictError, StorageConstraintError, type StorageConstraintKind } from '../src/storage/port.js';
import { createD1Storage, ensureSchema } from '../src/storage/d1.js';
import { loadArtifactDescriptors } from '../src/invocation/registry.js';
import { normalizeValueTypes } from '@canlang/values';
import { buildModelTableFromCanonical } from '../src/mutation/models.js';
import { activate, resumeMigration, validateTransition } from '../src/migration/index.js';
import { asId, asModel, asOperation, asRevision, asVersion, makeBatch, makeRow } from './invocation/fixtures.js';

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

