/** Node-only trusted composition of original State and physical Files retirement. */
import { createHash } from 'node:crypto';
import type { D1Database } from '@cloudflare/workers-types';
import type { ArtifactOperation, CanonicalOperationDescriptor, CompileArtifact, FilePolicy, FileReferenceInventory, FileRetentionPolicy,
  FileRetirementAuthority, FinalizedFileIdentity, FinalizedFileRef, FrameworkOpaqueDeclaration,
  FrameworkOpaqueDeclarationSet, FrameworkOpaqueValueDefault, Revision, WireValue, WorkScope } from '@canlang/contracts';
import type { IdentityStore } from '@canlang/identity';
import type { ClockPort } from '@canlang/files/ports';
import { createSqliteFileBindings, type SqliteFileStore } from '@canlang/files/host/sqlite';
import { checkedFileCleanupRecord } from '@canlang/files/retention';
import { createD1OwnerRouter, STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work';
import { encodeValue } from '@canlang/values';
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

/** Capture original native metadata before normalization or yielding. Never
 * invoke accessors, silently drop members, or coerce native integer literals. */
function declarationWire(value: unknown): WireValue {
  let nodes = 0, textBytes = 0;
  const ancestors = new Set<object>();
  const copy = (node: unknown, depth: number): WireValue => {
    if (++nodes > 20_000 || depth > 32) throw new Error('File retirement declaration capture exceeds its finite bounds.');
    if (typeof node === 'bigint') return encodeValue('int', node);
    if (node === null || typeof node === 'boolean') return node;
    if (typeof node === 'string') {
      textBytes += Buffer.byteLength(node);
      if (textBytes > 2_000_000) throw new Error('File retirement declaration text exceeds its finite bounds.');
      return node;
    }
    if (typeof node === 'number' && Number.isFinite(node)) return node;
    if (typeof node !== 'object' || node === null || ancestors.has(node)) throw new Error('File retirement requires closed original declaration data.');
    const array = Array.isArray(node), prototype = Object.getPrototypeOf(node);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error('File retirement requires plain original declaration data.');
    }
    ancestors.add(node);
    try {
      const keys = Reflect.ownKeys(node);
      if (array) {
        const length = data(node, 'length');
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length > 20_000 || keys.length !== length + 1) {
          throw new Error('File retirement requires dense original declaration arrays.');
        }
        const output: WireValue[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(node, String(index));
          if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) throw new Error('File retirement requires own declaration array data.');
          output.push(copy(descriptor.value, depth + 1));
        }
        return Object.freeze(output) as unknown as WireValue;
      }
      const output: Record<string, WireValue> = {};
      for (const key of keys) {
        const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(node, key) : undefined;
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable || typeof key !== 'string') {
          throw new Error('File retirement requires own enumerable declaration data.');
        }
        textBytes += Buffer.byteLength(key);
        if (textBytes > 2_000_000) throw new Error('File retirement declaration text exceeds its finite bounds.');
        Object.defineProperty(output, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
      }
      return Object.freeze(output);
    } finally { ancestors.delete(node); }
  };
  return copy(value, 0);
}

function originalDefaults(contracts: Readonly<Record<string, WireValue>>): readonly FrameworkOpaqueValueDefault[] {
  return Object.freeze(Object.keys(contracts).flatMap(contract => {
    const fields = data(contracts[contract], 'fields');
    return Object.keys(fields as object).flatMap(field => {
      const declaration = data(fields, field);
      return Object.hasOwn(declaration as object, 'default') ?
        [Object.freeze({ contract, field, value: data(declaration, 'default') as WireValue })] : [];
    });
  }));
}

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
  let verifyDeclarations = (): void => {};
  const verifyCurrent = async (): Promise<void> => {
    verifyDeclarations();
    await verifyAssemblerModuleCapability(asm, artifact);
    verifyDeclarations();
    if (JSON.stringify(artifact) !== artifactJson || physical.fileStoreId !== fileStoreId) throw new Error('File retirement original host correspondence changed.');
    const team = await identities.findTeamById(scope.owner);
    if (team === null || team.team_id !== scope.owner) throw new Error('File retirement requires the original current team.');
    await verifyAssemblerModuleCapability(asm, artifact);
    verifyDeclarations();
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
  const originalContracts = declarationWire(data(definition, 'contracts')) as Readonly<Record<string, WireValue>>;
  const valueDefaults = originalDefaults(originalContracts);
  const captures: { module: string; definition: unknown; invocations: Readonly<Record<string, WireValue>> }[] = [];
  const captureInvocations = (modulePath: string, original: unknown) => {
    const operations = data(original, 'operations');
    const invocations: Record<string, WireValue> = {};
    for (const callable of artifact.callables.filter(item => item.module === modulePath && item.kind === 'handler')) {
      Object.defineProperty(invocations, callable.id, { value: declarationWire(data(data(operations, callable.id), 'invocation')), enumerable: true });
    }
    captures.push({ module: modulePath, definition: original, invocations: Object.freeze(invocations) });
  };
  captureInvocations(first.path, definition);
  verifyDeclarations = () => {
    if (!equal(originalContracts, declarationWire(data(definition, 'contracts')))) throw new Error('File retirement original contracts changed after capture.');
    for (const captured of captures) {
      const operations = data(captured.definition, 'operations');
      for (const id of Object.keys(captured.invocations)) {
        if (!equal(captured.invocations[id], declarationWire(data(data(operations, id), 'invocation')))) {
          throw new Error('File retirement original private invocation changed after capture.');
        }
      }
    }
  };
  for (const emitted of artifact.modules.slice(1)) {
    if (!artifact.callables.some(item => item.module === emitted.path && item.kind === 'handler')) continue;
    const imported = await importVerifiedAssemblyModule(asm, emitted.path, artifact);
    captureInvocations(emitted.path, data(imported, 'appDefinition'));
    await verifyCurrent();
  }
  await verifyCurrent();
  const loaded = await loadCanonicalDescriptors(asm, artifact);
  await verifyCurrent();
  if (artifact.models === undefined || loaded.valueTypes === undefined) throw new Error('File retirement requires complete model and value declarations.');
  const inventoryIdentity = Object.freeze({ owner: scope.ownerPackage, snapshotId: `native-file:${digest}`, digest });
  const declarations: FrameworkOpaqueDeclaration[] = [];
  for (const callable of artifact.callables) {
    if (callable.kind !== 'operation' && callable.kind !== 'handler') continue;
    const emitted = artifact.modules.filter(candidate => candidate.path === callable.module);
    const paths = emitted.length === 1 ? emitted[0]!.map?.sources : undefined;
    const sources = artifact.sources.filter(source => paths?.includes(source.path));
    if (sources.length !== 1) throw new Error('File retirement requires one exact original callable source.');
    const source = { kind: 'callable' as const, source: { ...sources[0]!, module: callable.module }, callable };
    let operation: ArtifactOperation | undefined, canonical: CanonicalOperationDescriptor;
    if (callable.kind === 'handler') {
      const invocation = captures.find(captured => captured.module === callable.module)?.invocations[callable.id];
      operation = invocation as unknown as ArtifactOperation | undefined;
      if (operation?.name !== callable.id || operation.kind !== 'scenario') throw new Error('File retirement lacks its original private handler invocation.');
      const privateLoaded = loaded.producers.registry.loadArtifactDescriptors({ ...artifact, operations: [operation] }, { by: () => 'owner' });
      canonical = data(privateLoaded.registry.get(callable.id), 'descriptor') as CanonicalOperationDescriptor;
    } else {
      const operations = artifact.operations?.filter(candidate => candidate.name === callable.id);
      if (operations?.length !== 1) throw new Error('File retirement lacks its exact original callable operation.');
      operation = operations[0]!;
      canonical = data(loaded.registry.get(callable.id), 'descriptor') as CanonicalOperationDescriptor;
    }
    declarations.push({ id: `${callable.id}:inputs`, source,
      profile: { kind: 'inputs', canonical: canonical.inputs, artifact: operation.inputs.fields } });
    if (canonical.result !== undefined || operation.result !== undefined) {
      if (canonical.result === undefined || operation.result === undefined || !equal(canonical.result, operation.result)) {
        throw new Error('File retirement original callable results disagree.');
      }
      declarations.push({ id: `${callable.id}:result`, source,
        profile: canonical.result.type === 'void' ? { kind: 'void', canonical: { type: 'void' }, artifact: { type: 'void' } } :
          { kind: 'result', canonical: canonical.result, artifact: operation.result } });
    }
  }
  const baseInventory = immutable({ ...inventoryIdentity,
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
  const originalSnapshot = await store.readInstalledSnapshot(scope.ownerPackage);
  await verifyCurrent();
  const snapshot = installed?.snapshot ?? originalSnapshot ?? { ...inventoryIdentity,
    installedRevision: (expectedRevision + 1) as Revision, installedAt: clock.nowMs() };
  const declarationSet: FrameworkOpaqueDeclarationSet = immutable({ id: `${inventoryIdentity.snapshotId}:declarations`,
    inventory: inventoryIdentity, snapshot, sources: artifact.sources, canonicalModels: loaded.models,
    artifactModels: artifact.models, valueTypes: loaded.valueTypes, originalContracts, valueDefaults, declarations });
  if (installed !== null && !equal(installed.inventory.opaqueDeclarationSets, [declarationSet])) {
    throw new Error('File retirement original installed declaration closure changed.');
  }
  // Reopen keeps the persisted original closure and installation facts; fresh
  // source capture checks correspondence without rebuilding historical data.
  const inventory: FileReferenceInventory = immutable({ ...baseInventory,
    opaqueDeclarationSets: installed?.inventory.opaqueDeclarationSets ?? [declarationSet] });
  await store.installFileReferenceInventory({ expectedRevision, authority, inventory,
    snapshot });
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
