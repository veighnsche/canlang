/** Node-only trusted composition of original State and physical Files retirement. */
import { createHash } from 'node:crypto';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, FilePolicy, FileReferenceInventory, FileRetentionPolicy,
  FileRetirementAuthority, FinalizedFileIdentity, FinalizedFileRef, WorkScope } from '@canlang/contracts';
import type { IdentityStore } from '@canlang/identity';
import type { ClockPort } from '@canlang/files/ports';
import { createSqliteFileBindings, type SqliteFileStore } from '@canlang/files/host/sqlite';
import { checkedFileCleanupRecord } from '@canlang/files/retention';
import { createD1OwnerRouter, STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work';
import type { AssembledModules } from '../runtime/modules.js';
import { importVerifiedAssemblyModule, verifyAssemblerModuleCapability } from '../runtime/assembly-verification.js';
import { loadCanonicalDescriptors } from '../runtime/invoke.js';
import { createTeamOwnerStorageBoundary } from '../worker/assembly.js';

export interface NativeFileRetirementInput {
  readonly artifact: CompileArtifact;
  readonly asm: AssembledModules;
  readonly scope: WorkScope;
  readonly identities: IdentityStore;
  readonly db: D1Database;
  readonly stateStoreId: string;
  readonly physicalSqliteFileStore: SqliteFileStore;
  readonly initializeFresh?: true;
  readonly clock: ClockPort;
  readonly intentTtlMs: number;
  readonly urlBase: string;
  readonly policy?: FilePolicy;
  readonly retention: FileRetentionPolicy;
  readonly maxRows: number;
  readonly maxReferences: number;
}

function data(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) throw new Error('File retirement requires checked declaration data.');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) throw new Error(`File retirement requires own ${key} data.`);
  return descriptor.value;
}
function text(value: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('File retirement requires a nonempty host identity.');
  return value;
}
function bounded(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('File retirement requires finite complete census bounds.');
  return value;
}
function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (node: unknown): void => {
    if (node !== null && typeof node === 'object') {
      for (const member of Object.values(node)) freeze(member);
      Object.freeze(node);
    }
  };
  freeze(copy); return copy;
}
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** Never runs cleanup on installation; the returned method is trusted host maintenance only. */
export async function createNativeFileRetirementBinding(input: NativeFileRetirementInput) {
  // Capture original ports/configuration before the first source or database await.
  const { artifact, asm, identities, db, physicalSqliteFileStore: physical } = input;
  const scope = Object.freeze({ app: text(input.scope.app), ownerPackage: text(input.scope.ownerPackage), owner: text(input.scope.owner) });
  if (scope.owner === 'app') throw new Error('Native File retirement requires a selected team owner.');
  const stateStoreId = text(input.stateStoreId), fileStoreId = text(physical.fileStoreId);
  const clockMethod = input.clock.nowMs, originalClock = input.clock;
  const clock: ClockPort = Object.freeze({ nowMs: () => {
    const at = clockMethod.call(originalClock);
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('File retirement requires a current finite clock.');
    return at;
  } });
  const retention = immutable(input.retention), policy = input.policy === undefined ? undefined : immutable(input.policy);
  if (Object.keys(retention).sort().join(',') !== 'retentionMs,unattachedHorizonMs' ||
      !Number.isSafeInteger(retention.retentionMs) || retention.retentionMs < 0 ||
      !Number.isSafeInteger(retention.unattachedHorizonMs) || retention.unattachedHorizonMs < 0) {
    throw new Error('File retirement requires explicit finite original retention.');
  }
  const maxRows = bounded(input.maxRows, 10_000), maxReferences = bounded(input.maxReferences, 20_000);
  const intentTtlMs = input.intentTtlMs, urlBase = input.urlBase, initializeFresh = input.initializeFresh;
  const artifactJson = JSON.stringify(artifact);
  const digest = `sha256:${createHash('sha256').update(artifactJson).digest('hex')}`;
  const authority: FileRetirementAuthority = Object.freeze({ app: scope.app, stateOwner: scope.ownerPackage,
    stateStoreId, fileStoreId, receiver: Object.freeze({ app: scope.app, team: scope.owner, owner: scope.owner }) });
  const verifyCurrent = async (): Promise<void> => {
    await verifyAssemblerModuleCapability(asm, artifact);
    if (JSON.stringify(artifact) !== artifactJson || physical.fileStoreId !== fileStoreId) throw new Error('File retirement original host correspondence changed.');
    const team = await identities.findTeamById(scope.owner);
    if (team === null || team.team_id !== scope.owner) throw new Error('File retirement requires the original current team.');
    await verifyAssemblerModuleCapability(asm, artifact);
    if (JSON.stringify(artifact) !== artifactJson || physical.fileStoreId !== fileStoreId) throw new Error('File retirement original host correspondence changed.');
  };
  await verifyCurrent();
  const first = artifact.modules[0];
  if (first === undefined) throw new Error('File retirement requires an original entry module.');
  const module = await importVerifiedAssemblyModule(asm, first.path, artifact);
  const definition = data(module, 'appDefinition');
  if (data(definition, 'id') !== scope.app) throw new Error('File retirement declared app differs from the owner.');
  const packages = data(definition, 'packages');
  data(packages, scope.ownerPackage);
  await verifyCurrent();
  const loaded = await loadCanonicalDescriptors(asm, artifact);
  await verifyCurrent();
  if (artifact.models === undefined || loaded.valueTypes === undefined) throw new Error('File retirement requires complete model and value declarations.');
  const inventory: FileReferenceInventory = immutable({ owner: scope.ownerPackage, snapshotId: `native-file:${digest}`, digest,
    canonicalModels: loaded.models, artifactModels: artifact.models, valueTypes: loaded.valueTypes,
    frameworkModels: [...STATE_FILE_REFERENCE_PRODUCER.models, ...WORK_FILE_REFERENCE_PRODUCER.models] });
  const route = Object.freeze({ app: scope.app, owner: scope.owner, db,
    ...(initializeFresh === true ? { initializeFresh: true as const } : {}),
    fileRetirementAuthority: authority,
    fileReferenceProducers: Object.freeze([STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]) });
  const router = createD1OwnerRouter({ resolveBinding: selected => selected.app === scope.app && selected.owner === scope.owner ? route : null });
  const ownerStorage = await createTeamOwnerStorageBoundary({ artifact, asm, app: scope.app, identities, router });
  await verifyCurrent();
  const { store } = await ownerStorage.forTrustedScope(scope, clock.nowMs());
  await verifyCurrent();
  const installed = await store.readFileReferenceInventory(scope.ownerPackage);
  await verifyCurrent();
  const expectedRevision = await store.readRevision();
  await verifyCurrent();
  await store.installFileReferenceInventory({ expectedRevision, authority, inventory,
    snapshot: installed?.snapshot ?? { owner: inventory.owner, snapshotId: inventory.snapshotId, digest,
      installedRevision: expectedRevision, installedAt: clock.nowMs() } });
  await verifyCurrent();
  const bindings = createSqliteFileBindings(physical, { clock, intentTtlMs, urlBase,
    ...(policy === undefined ? {} : { policy }), fileRetirement: { storage: store, retention } });
  return Object.freeze({ store, ownerStorage, bindings,
    async retireAndDelete(ref: FinalizedFileRef, disposition: 'orphaned' | 'expired') {
      if (typeof ref !== 'string' || ref === '' || !['orphaned', 'expired'].includes(disposition)) throw new Error('File retirement requires an exact File and disposition.');
      await verifyCurrent();
      const previous = await store.readFinalizedFileRetirement(ref);
      await verifyCurrent();
      const raw = physical.files.get(ref);
      const record = raw === null ? null : checkedFileCleanupRecord(raw);
      const file: FinalizedFileIdentity | null = record === null ? null : Object.freeze({ ref: record.file.id,
        receiver: record.owner, provenance: record.file.provenance, contentType: record.file.contentType,
        sizeBytes: record.file.sizeBytes, bytesDigest: record.file.bytesDigest, finalizedAtMs: record.finalizedAtMs });
      if (file !== null && (file.ref !== ref || file.receiver.app !== scope.app || file.receiver.team !== scope.owner || file.receiver.owner !== scope.owner)) {
        throw new Error('File retirement physical receiver differs from its original owner.');
      }
      if (previous !== null && (!equal(previous.authority, authority) || previous.disposition !== disposition ||
          !equal(previous.retention, retention) || previous.snapshot.owner !== inventory.owner ||
          previous.snapshot.snapshotId !== inventory.snapshotId || previous.snapshot.digest !== digest ||
          file !== null && !equal(previous.file, file))) throw new Error('File retirement original decision cannot be replaced.');
      const originalFile = previous?.file ?? file;
      if (originalFile === null) throw new Error('File retirement requires a physical original or a durable original State decision.');
      const revision = await store.readRevision();
      await verifyCurrent();
      const retirement = await store.retireFinalizedFile({ expectedRevision: revision,
        inventory: { owner: inventory.owner, snapshotId: inventory.snapshotId, digest }, file: originalFile,
        disposition, retention, atMs: clock.nowMs(), maxRows, maxReferences });
      await verifyCurrent();
      const result = await bindings.deleteRetiredFile(ref);
      await verifyCurrent();
      return Object.freeze({ retirement, result });
    },
  });
}
