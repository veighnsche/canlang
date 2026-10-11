/** Portable correspondence leaf for the installed generation callback reader. */
import type { CompileArtifact, GenerationCallbackOrigin, OutboxId, RecordId, Revision, StoragePort } from '@canlang/contracts';
import { FenceConflictError } from '@canlang/state/storage/port';
import type { GeneratedOperationDef } from '@canlang/state/invocation/registry';
import { WORK_DISPATCH_MODEL, readDispatchRow, readDispatchImageCorrelation } from '@canlang/work/kernel/tables';
import { deriveOutboxIdAsync } from '@canlang/work/intent/staging';
import type { AssembledModules } from './modules.js';
import { importVerifiedAssemblyModule, verifyAssemblerModuleCapability } from './assembly-verification.js';
import { loadCanonicalDescriptors } from './invoke.js';

/** Resolve retained original generation provenance after State has authorized its association.
 * This installed helper supplies correspondence only; it grants no viewer authority.
 */
export async function resolveGenerationCallbackOrigin(input: {
  readonly artifact: CompileArtifact;
  readonly asm: AssembledModules;
  readonly app: string;
  readonly owner: string;
  readonly ownerPackage: string;
  readonly model: string;
  readonly recordId: string;
  readonly field: string;
  readonly deliveryId: string;
  readonly source: GenerationCallbackOrigin['source'];
  readonly expectedRevision: Revision;
}, store: StoragePort): Promise<GenerationCallbackOrigin | null> {
  const own = (value: unknown, key: string): unknown => {
    if (typeof value !== 'object' || value === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  };
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
    object(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key =>
      Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && own(value, key) !== undefined);
  const text = (value: unknown): value is string => {
    if (typeof value !== 'string' || value === '' || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) return false;
    try { encodeURIComponent(value); return true; } catch { return false; }
  };
  const fence = async (): Promise<void> => {
    const actual = await store.readRevision();
    if (actual !== input.expectedRevision) throw new FenceConflictError(input.expectedRevision, actual);
  };
  try {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
        ![input.app, input.owner, input.ownerPackage, input.model, input.recordId, input.field, input.deliveryId].every(text) ||
        !['std.ImagesV1.submit', 'std.TextGenerationV1.generate'].includes(input.source) ||
        !input.model.startsWith(`${input.ownerPackage}.`) || typeof store.cohortLoad !== 'function' ||
        typeof store.outboxGetBounded !== 'function') return null;
    await verifyAssemblerModuleCapability(input.asm, input.artifact);
    await fence();
    const models = input.artifact.models?.filter(model => model.name === input.model);
    if (models?.length !== 1) return null;
    const fields = models[0]!.fields.filter(field => field.name === input.field);
    const field = fields[0];
    if (fields.length !== 1 || field?.field.kind !== 'delivery' || field.array !== undefined ||
        `${field.field.capability}.${field.field.operation}` !== input.source) return null;
    const row = await store.cohortLoad.call(store, { model: WORK_DISPATCH_MODEL,
      id: input.deliveryId as RecordId, expectedRevision: input.expectedRevision });
    if (row === null || row.id !== input.deliveryId || row.archivedAt !== null ||
        typeof row.createdBy !== 'string' || row.createdBy === '') return null;
    const dispatch = readDispatchRow(row), correlation = readDispatchImageCorrelation(row.data);
    if (correlation === null || dispatch.intentId !== row.id || dispatch.source !== input.source ||
        correlation.requestApp !== input.app || correlation.requestOwner !== input.owner ||
        !correlation.requestBinding.startsWith(`${input.ownerPackage}.`) ||
        !/^(0|[1-9][0-9]*)$/.test(correlation.requestRevision)) return null;
    await fence();
    const retained = await store.outboxGetBounded.call(store, {
      intentId: input.deliveryId as OutboxId, expectedRevision: input.expectedRevision });
    if (retained === null || !['pending', 'dispatched', 'skipped'].includes(retained.status)) return null;
    const { intent, originalCommit: stamp } = retained;
    if (stamp === undefined || !Number.isSafeInteger(stamp.revision) || stamp.revision < 1 ||
        stamp.revision > input.expectedRevision || !Number.isSafeInteger(stamp.createdAt) || stamp.createdAt < 0 ||
        stamp.createdAt !== row.created || intent.intentId !== input.deliveryId || intent.target !== input.source ||
        intent.operationId !== dispatch.operationId || intent.occurrenceIndex !== dispatch.occurrenceIndex ||
        await deriveOutboxIdAsync(intent.operationId, intent.target, intent.occurrenceIndex) !== input.deliveryId ||
        !exact(intent.arguments, ['binding', 'from', 'arguments']) ||
        intent.arguments.binding !== correlation.requestBinding || intent.arguments.from !== correlation.requestFrom ||
        !exact(intent.arguments.arguments, ['value'])) return null;
    const value = intent.arguments.arguments.value;
    if (!object(value) || own(value, 'source') !== correlation.requestSource ||
        own(value, 'revision') !== correlation.requestRevision) return null;
    const loaded = await loadCanonicalDescriptors(input.asm, input.artifact, store);
    const originals = input.artifact.callables.filter(callable => callable.id === intent.operation);
    if (originals.length !== 1) return null;
    const original = originals[0]!;
    const imported = await importVerifiedAssemblyModule(input.asm, original.module, input.artifact);
    const definition = own(imported, 'appDefinition');
    const binding = own(own(definition, 'bindings'), correlation.requestBinding);
    const capability = input.source.slice(0, input.source.lastIndexOf('.'));
    if (own(definition, 'id') !== input.app || own(own(definition, 'packages'), input.ownerPackage) === undefined ||
        own(binding, 'capability') !== capability || own(binding, 'from') !== correlation.requestFrom) return null;
    const factory = own(imported, 'canApp');
    if (typeof factory !== 'function') return null;
    let originalFn: unknown = factory();
    for (const member of original.member) originalFn = own(originalFn, member);
    if (typeof originalFn !== 'function') return null;
    const event = `${correlation.requestBinding}.${input.source.slice(input.source.lastIndexOf('.') + 1)}.progressed`;
    const handlers: string[] = [];
    for (const module of input.artifact.modules) {
      const namespace = await importVerifiedAssemblyModule(input.asm, module.path, input.artifact);
      const declared = own(namespace, 'appDefinition'), operations = own(declared, 'operations');
      // Interface/helper modules need no app operation inventory. A direct
      // owning scenario callable still needs its declaration; hooks use their
      // separate member path and cannot be ordinary progressed handlers.
      if (operations === undefined) {
        if (input.artifact.callables.some(callable => callable.module === module.path && callable.kind === 'handler' &&
            callable.id.startsWith(`${input.ownerPackage}.`) && callable.member.length === 1 && callable.member[0] === callable.id)) return null;
        continue;
      }
      if (!object(operations)) return null;
      for (const id of Object.keys(operations)) {
        const handler = own(operations, id);
        if (own(handler, 'event') !== event) continue;
        const matches = input.artifact.callables.filter(callable => callable.kind === 'handler' &&
          callable.id === id && callable.module === module.path);
        const callable = matches[0], invocation = own(handler, 'invocation');
        const inputs = own(own(own(declared, 'events'), event), 'inputs');
        const bound = own(own(declared, 'bindings'), correlation.requestBinding);
        if (matches.length !== 1 || callable === undefined || callable.member.length !== 1 || callable.member[0] !== id ||
            id.slice(0, id.lastIndexOf('.')) !== input.ownerPackage || handlers.includes(id) || handlers.length >= 100 ||
            own(declared, 'id') !== input.app || own(own(declared, 'packages'), input.ownerPackage) === undefined ||
            own(bound, 'capability') !== capability || own(bound, 'from') !== correlation.requestFrom ||
            own(handler, 'handler') !== id || own(invocation, 'name') !== id || own(invocation, 'kind') !== 'scenario' ||
            !exact(inputs, ['delivery_id']) || own(own(inputs, 'delivery_id'), 'type') !== 'text') return null;
        const descriptors = loaded.producers.registry.loadArtifactDescriptors(
          { ...input.artifact, operations: [invocation] }, { by: () => 'owner' });
        const privateDef = descriptors.registry.get(id) as GeneratedOperationDef | undefined;
        const descriptor = privateDef?.descriptor;
        if (descriptor === undefined || descriptor.inputs.length !== 1 || descriptor.inputs[0]?.name !== 'delivery_id' ||
            descriptor.inputs[0]?.kind !== 'string' || descriptor.inputs[0]?.required !== true ||
            descriptor.inputs[0]?.valueType !== 'text') return null;
        const create = own(namespace, 'canApp');
        if (typeof create !== 'function' || typeof own(create(), id) !== 'function') return null;
        handlers.push(id);
      }
    }
    if (handlers.length === 0) return null;
    await verifyAssemblerModuleCapability(input.asm, input.artifact);
    await fence();
    return Object.freeze({ source: input.source, sourceRevision: correlation.requestRevision,
      binding: correlation.requestBinding, from: correlation.requestFrom,
      scope: Object.freeze({ app: input.app, owner: input.owner, ownerPackage: input.ownerPackage }),
      event, handlers: Object.freeze(handlers.sort()) });
  } catch (error) {
    if (error instanceof FenceConflictError) throw error;
    return null;
  }
}
