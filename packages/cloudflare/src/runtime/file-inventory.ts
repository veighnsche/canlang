/** Worker-safe installation of the original compiler/State opaque declaration inventory. */
import type { ArtifactModel, ArtifactOperation, CanonicalModelDescriptor, CanonicalOperationDescriptor, CompileArtifact,
  FileReferenceInventory, FileReferenceStoragePort, FileRetirementAuthority, FrameworkOpaqueDeclaration,
  FrameworkOpaqueDeclarationSet, FrameworkOpaqueValueDefault, Revision, WireValue, WorkScope } from '@canlang/contracts';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { stableStringify } from '@canlang/state/invocation';
import { dispatchGenerationTargetProfile } from '@canlang/work/kernel/tables';
import { encodeValue } from '@canlang/values';
import type { AssembledModules } from './modules.js';
import { importVerifiedAssemblyModule, verifyAssemblerModuleCapability } from './assembly-verification.js';
import { loadCanonicalDescriptors } from './invoke.js';
import { checkedNativeValueTypes } from './native-value-schema.js';

export interface NativeFileInventoryInput {
  readonly artifact: CompileArtifact;
  readonly asm: AssembledModules;
  readonly scope: WorkScope;
  readonly store: FileReferenceStoragePort;
  readonly authority: FileRetirementAuthority;
  readonly now: () => number;
  /** Trusted host rechecks the actual configured physical owner. */
  readonly verifyOwner: () => Promise<void>;
}

function data(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) throw new Error('File retirement requires checked declaration data.');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) throw new Error(`File retirement requires own ${key} data.`);
  return descriptor.value;
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
const equal = (left: unknown, right: unknown): boolean => stableStringify(left) === stableStringify(right);

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
      textBytes += new TextEncoder().encode(node).byteLength;
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
        textBytes += new TextEncoder().encode(key).byteLength;
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

/** Install original ordinary capability result profiles. Generation and Judgment
 * retain their separately defining original-request/specification joins. */
export function nativeCapabilityResultDeclarations(
  caller: Extract<FrameworkOpaqueDeclaration['source'], { kind: 'callable' }>,
  canonicalModels: readonly CanonicalModelDescriptor[], artifactModels: readonly ArtifactModel[],
): readonly FrameworkOpaqueDeclaration[] {
  const output: FrameworkOpaqueDeclaration[] = [];
  for (const model of artifactModels) {
    const originals = canonicalModels.filter(candidate => candidate.name === model.name);
    if (originals.length !== 1) throw new Error('File retirement requires one exact original delivery model.');
    for (const field of model.fields) {
      if (field.field.kind !== 'delivery') continue;
      const canonical = originals[0]!.fields[field.name]?.delivery;
      if (canonical === undefined || !equal(canonical, field.field)) {
        throw new Error('File retirement original delivery field declarations disagree.');
      }
      if ('judgment' in field.field) continue;
      const generation = dispatchGenerationTargetProfile(`${field.field.capability}.${field.field.operation}`);
      // Control requests retain their separately defining original-request join.
      if (generation !== null && generation.role !== 'original') continue;
      if ('judgment' in canonical) throw new Error('File retirement original delivery variants disagree.');
      if (output.some(declaration => declaration.source.kind === 'delivery' &&
          equal(declaration.source.context.canonical, canonical))) continue;
      output.push({ id: `${caller.callable.id}:delivery:${model.name}:${field.name}:result`,
        source: { kind: 'delivery', source: caller.source,
          context: { kind: generation === null ? 'capability' : 'generation-profile', canonical, artifact: field.field } },
        profile: { kind: 'provider-result', canonical: canonical.result, artifact: field.field.result } });
    }
  }
  return immutable(output);
}

/** Installs once, or verifies the persisted original closure on reopen. */
export async function installNativeFileInventory(input: NativeFileInventoryInput) {
  const { artifact, asm, store, now, verifyOwner } = input;
  const scope = immutable(input.scope), authority = immutable(input.authority);
  const artifactJson = JSON.stringify(artifact);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(artifactJson));
  const digest = `sha256:${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  let verifyDeclarations = (): void => {};
  const verifyCurrent = async (): Promise<void> => {
    verifyDeclarations();
    await verifyAssemblerModuleCapability(asm, artifact);
    await verifyOwner();
    verifyDeclarations();
    if (JSON.stringify(artifact) !== artifactJson || !equal(store.fileRetirementAuthority, authority) ||
        authority.app !== scope.app ||
        authority.receiver.app !== scope.app || authority.receiver.owner !== scope.owner || authority.receiver.team !== scope.owner) {
      throw new Error('Original declaration inventory differs from its configured physical owner.');
    }
    await verifyAssemblerModuleCapability(asm, artifact);
    verifyDeclarations();
    if (JSON.stringify(artifact) !== artifactJson) throw new Error('Original declaration source changed during installation.');
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
  const captures: { module: string; definition: unknown; invocations: Readonly<Record<string, WireValue>>; events: Readonly<Record<string, WireValue>>; sendGuards: Readonly<Record<string, WireValue>> }[] = [];
  const captureInvocations = (modulePath: string, original: unknown) => {
    const operations = data(original, 'operations');
    const invocations: Record<string, WireValue> = {};
    for (const callable of artifact.callables.filter(item => item.module === modulePath && item.kind === 'handler')) {
      Object.defineProperty(invocations, callable.id, { value: declarationWire(data(data(operations, callable.id), 'invocation')), enumerable: true });
    }
    const sendGuards: Record<string, WireValue> = {};
    for (const operation of Object.keys(operations as object)) {
      const declaration = data(operations, operation);
      if (Object.hasOwn(declaration as object, 'sendGuards')) Object.defineProperty(sendGuards, operation, {
        value: declarationWire(data(declaration, 'sendGuards')), enumerable: true });
    }
    const events = declarationWire(data(original, 'events')) as Readonly<Record<string, WireValue>>;
    captures.push({ module: modulePath, definition: original, invocations: Object.freeze(invocations), events, sendGuards: Object.freeze(sendGuards) });
  };
  captureInvocations(first.path, definition);
  verifyDeclarations = () => {
    if (!equal(originalContracts, declarationWire(data(definition, 'contracts')))) throw new Error('File retirement original contracts changed after capture.');
    for (const captured of captures) {
      if (!equal(captured.events, declarationWire(data(captured.definition, 'events')))) {
        throw new Error('File retirement original event declarations changed after capture.');
      }
      const operations = data(captured.definition, 'operations');
      const guarded = Object.keys(operations as object).filter(id => Object.hasOwn(data(operations, id) as object, 'sendGuards'));
      if (!equal(guarded, Object.keys(captured.sendGuards))) throw new Error('Original SEND declaration inventory changed.');
      for (const id of guarded) if (!equal(captured.sendGuards[id], declarationWire(data(data(operations, id), 'sendGuards')))) {
        throw new Error('Original SEND lexical declaration changed after capture.');
      }
      for (const id of Object.keys(captured.invocations)) {
        if (!equal(captured.invocations[id], declarationWire(data(data(operations, id), 'invocation')))) {
          throw new Error('File retirement original private invocation changed after capture.');
        }
      }
    }
  };
  for (const emitted of artifact.modules.slice(1)) {
    const imported = await importVerifiedAssemblyModule(asm, emitted.path, artifact);
    // Composed apps include verified constant-only package facades. They
    // carry no writer/handler declarations; all actual callables remain in
    // their artifact-selected defining module. Never skip a missing actual
    // callable census or invoke an accessor as declaration metadata.
    if (Object.getOwnPropertyDescriptor(imported, 'appDefinition') === undefined) {
      if (artifact.callables.some(callable => callable.module === emitted.path &&
          (callable.kind === 'operation' || callable.kind === 'handler'))) {
        throw new Error('File retirement callable module lacks its own appDefinition data.');
      }
      await verifyCurrent();
      continue;
    }
    captureInvocations(emitted.path, data(imported, 'appDefinition'));
    await verifyCurrent();
  }
  await verifyCurrent();
  const loaded = await loadCanonicalDescriptors(asm, artifact);
  await verifyCurrent();
  if (artifact.models === undefined) throw new Error('File retirement requires complete model declarations.');
  const valueTypes = checkedNativeValueTypes(artifact, definition, loaded.valueTypes);
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
    const originalCapture = captures.find(captured => captured.module === callable.module);
    const guarded = originalCapture?.sendGuards[callable.id];
    if (guarded !== undefined) {
      if (!Array.isArray(guarded) || originalCapture === undefined) throw new Error('Original SEND guard inventory must be complete.');
      const originalPackages = data(originalCapture.definition, 'packages');
      const owningPackage = Object.keys(originalPackages as object).filter(name => callable.id.startsWith(`${name}.`))
        .sort((left, right) => right.length - left.length)[0];
      if (owningPackage === undefined) throw new Error('Original SEND guard lacks its owning lexical package.');
      for (const entry of guarded) {
        const guard = entry as unknown as Record<string, unknown>;
        const profile = data(guard, 'inputDeclaration') as FrameworkOpaqueDeclaration['profile'];
        const originalSource = data(guard, 'source') as { path: string; sha256: string; module: string };
        const rule = data(guard, 'rule') as string;
        const rules = artifact.callables.filter(candidate => candidate.kind === 'rule' && candidate.id === rule &&
          candidate.module === callable.module && equal(candidate.member, ['sendWhen', rule]));
        if (Object.keys(guard).sort().join(',') !== 'binding,inputDeclaration,inputs,node,owner,rule,source,sourceBinding,statement,target' ||
            data(guard, 'owner') !== callable.id || originalSource.path !== source.source.path ||
            originalSource.sha256 !== source.source.sha256 || originalSource.module !== owningPackage ||
            rules.length !== 1 || rules[0]!.inputStyle !== undefined || profile.kind !== 'inputs') {
          throw new Error('Original SEND guard lacks its complete owning Compiler declaration.');
        }
        const inputs = data(guard, 'inputs') as readonly { name: string; type: import('@canlang/contracts').CanTypeId }[];
        if (profile.canonical.length !== inputs.length || profile.artifact.length !== inputs.length || inputs.some((input, index) =>
            profile.canonical[index]?.name !== input.name || profile.artifact[index]?.name !== input.name ||
            profile.artifact[index]?.valueType !== input.type || profile.canonical[index]?.required !== true ||
            profile.artifact[index]?.required !== true || ['default', 'computedDefault'].some(key =>
            Object.hasOwn(profile.canonical[index]!, key) || Object.hasOwn(profile.artifact[index]!, key)))) throw new Error('Original SEND slots must retain their complete required typed declaration.');
        declarations.push({ id: `${rule}:send-inputs`, source: { kind: 'send-guard', rule,
          source: source.source, owner: callable.id, node: data(guard, 'node') as { start: number; end: number },
          binding: data(guard, 'binding') as string, target: data(guard, 'target') as string, inputs }, profile });
      }
    }
    declarations.push(...nativeCapabilityResultDeclarations(source, loaded.models, artifact.models));
    if (canonical.result !== undefined || operation.result !== undefined) {
      if (canonical.result === undefined || operation.result === undefined || !equal(canonical.result, operation.result)) {
        throw new Error('File retirement original callable results disagree.');
      }
      declarations.push({ id: `${callable.id}:result`, source,
        // Explicit void still retains the Compiler's original disclosure plan.
        profile: canonical.result.type === 'void' ? { kind: 'void',
          canonical: { ...canonical.result, type: 'void' }, artifact: { ...operation.result, type: 'void' } } :
          // The opaque closure binds a result's File profile from its type
          // alone; the disclosure plan stays with the loaded descriptor and
          // is not persisted a second time inside this inventory.
          { kind: 'result', canonical: { type: canonical.result.type },
            artifact: { type: operation.result.type } } });
    }
  }
  const events = new Set<string>();
  for (const captured of captures) {
    for (const event of Object.keys(captured.events)) {
      const original = data(captured.events, event);
      // Owning lifecycle schemas are distinct from original declared events.
      // The Compiler's positive own inputFields carrier identifies the latter.
      if (!Object.hasOwn(original as object, 'inputFields')) continue;
      if (events.has(event)) throw new Error('File retirement requires one exact original event module.');
      events.add(event);
      const emitted = artifact.modules.filter(candidate => candidate.path === captured.module);
      const paths = emitted.length === 1 ? emitted[0]!.map?.sources : undefined;
      const sources = artifact.sources.filter(source => paths?.includes(source.path));
      if (sources.length !== 1) throw new Error('File retirement requires one exact original event source.');
      // These are detached bytes captured before subsequent imports/DB awaits;
      // State owns their canonical field conversion, including File wrappers.
      data(original, 'inputs');
      const fields = data(original, 'inputFields');
      if (!Array.isArray(fields)) throw new Error('File retirement requires complete original event input fields.');
      const operation: ArtifactOperation = { name: event, kind: 'scenario', description: '',
        inputs: { fields: fields as ArtifactOperation['inputs']['fields'] } };
      const eventLoaded = loaded.producers.registry.loadArtifactDescriptors(
        { ...artifact, operations: [operation] }, { by: () => 'owner' });
      const canonical = data(eventLoaded.registry.get(event), 'descriptor') as CanonicalOperationDescriptor;
      declarations.push({ id: `${event}:event-inputs`,
        source: { kind: 'event', source: { ...sources[0]!, module: captured.module }, event },
        profile: { kind: 'inputs', canonical: canonical.inputs, artifact: operation.inputs.fields } });
    }
  }
  const baseInventory = immutable({ ...inventoryIdentity,
    canonicalModels: loaded.models, artifactModels: artifact.models, valueTypes,
    frameworkModels: [...STATE_FILE_REFERENCE_PRODUCER.models, ...WORK_FILE_REFERENCE_PRODUCER.models] });
  const installed = await store.readFileReferenceInventory(scope.ownerPackage);
  await verifyCurrent();
  const expectedRevision = await store.readRevision();
  await verifyCurrent();
  const originalSnapshot = await store.readInstalledSnapshot(scope.ownerPackage);
  await verifyCurrent();
  const snapshot = installed?.snapshot ?? originalSnapshot ?? { ...inventoryIdentity,
    installedRevision: (expectedRevision + 1) as Revision, installedAt: now() };
  const declarationSet: FrameworkOpaqueDeclarationSet = immutable({ id: `${inventoryIdentity.snapshotId}:declarations`,
    inventory: inventoryIdentity, snapshot, sources: artifact.sources, canonicalModels: loaded.models,
    artifactModels: artifact.models, valueTypes, originalContracts, valueDefaults, declarations });
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
  return Object.freeze({ inventory, verifyCurrent });
}
