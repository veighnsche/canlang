/** Trusted same-load File payload composition; declaration tags grant no authority. */
import type {
  ArtifactOperation, CanonicalModelDescriptor, CanonicalOperationDescriptor, CanonicalValueTypes,
  CompileArtifact, FileReferenceStoragePort, FrameworkFilePayloadOrigin, FrameworkOpaqueCallable,
  FrameworkOpaqueDeclaration, FrameworkOpaqueDeclarationSet, FrameworkOpaqueEventDeclaration, FrameworkOpaqueValueProjection,
  FrameworkOpaqueDeliveryContext, FrameworkOpaqueSendGuardDeclaration,
  OutboxIntent, RecordId, ModelName, ResolvedIdentity, RetainedFinalizedFile, Revision, StoredRow, WorkScope,
} from '@canlang/contracts';

type CallableDeclarationSource = Extract<FrameworkOpaqueDeclaration['source'], { kind: 'callable' }>;
import { STATE_FILE_REFERENCE_PRODUCER, bindOpaqueFileDeclarations, prepareFrameworkFilePayloadOrigin, resolveOpaqueFileProjection, validateOpaqueFileOrigin } from '@canlang/state/storage';
import { observeRetainedCanonicalFile, readRetainedCanonicalFile, type CanonicalFileBinding } from './file-staging.js';
import { readRetainedSendInputs } from '@canlang/work/kernel/dispatch-staging';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work';
import { stableStringify } from '@canlang/state/invocation';
import type { ScenarioReceiptDeliveryOriginFrame, ScenarioReceiptSendGuard } from '@canlang/state/invocation';
import { WORK_DISPATCH_MODEL, dispatchGenerationTargetProfile } from '@canlang/work/kernel/tables';

export interface RetainedOpaqueFileSource {
  readonly model: ModelName;
  readonly row: StoredRow;
  readonly field: 'payload' | 'result' | 'sourceGuard' | 'queuePayload' | 'sendInputs';
  readonly binding: FrameworkFilePayloadOrigin;
}

export interface OpaqueFileStagingInput {
  /** The original registered physical port, never an execution overlay. */
  readonly store: FileReferenceStoragePort;
  readonly inventoryOwner: string;
  readonly declarationSetId?: string;
  readonly artifact: CompileArtifact;
  readonly canonicalModels: readonly CanonicalModelDescriptor[];
  readonly valueTypes: CanonicalValueTypes;
  readonly operations: ReadonlyMap<string, {
    readonly canonical: CanonicalOperationDescriptor; readonly artifact: ArtifactOperation;
  }>;
  readonly scope: WorkScope;
  /** Genuine assembly/source and current owner verification, supplied by host. */
  readonly verify: () => Promise<void>;
}

/** Detach persisted own data only; opaque live File handles never enter this copy. */
function captureData<T>(value: T, active = new Set<object>()): T {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' || typeof value === 'boolean' ||
        typeof value === 'number' && Number.isFinite(value) || value === null) return value;
    return refuse('closed original own data required');
  }
  if (active.has(value) || Object.getOwnPropertySymbols(value).length !== 0) refuse('acyclic original own data required');
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype :
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) refuse('plain original own data required');
  active.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy: unknown[] | Record<string, unknown> = array ? [] : Object.create(null) as Record<string, unknown>;
  const keys = Reflect.ownKeys(value).filter(key => key !== 'length' || !array) as string[];
  if (array && (keys.length !== (value as unknown[]).length ||
      keys.some((key, index) => key !== String(index)))) refuse('dense original own data required');
  for (const key of keys) {
    const property = descriptors[key]!;
    if (!('value' in property) || !property.enumerable) refuse('original own data property required');
    Object.defineProperty(copy, key, { value: captureData(property.value, active), enumerable: true });
  }
  active.delete(value);
  return Object.freeze(copy) as T;
}
function structural(value: unknown): string { return stableStringify(captureData(value)); }
function equal(left: unknown, right: unknown): boolean {
  return left === undefined || right === undefined ? left === right : structural(left) === structural(right);
}
function captureSource(source: RetainedOpaqueFileSource): RetainedOpaqueFileSource { return captureData(source); }
function refuse(message: string): never { throw new Error(`Opaque File staging: ${message}`); }
/** The File census owns the declared result shape. Receipt disclosure is
 * separately authenticated execution evidence, retained in the complete
 * artifact/operation snapshots, rather than a File type or its opaque header. */
function resultDeclaration<T>(value: T): T {
  if (value === undefined) return value;
  const copied = captureData(value);
  if (typeof copied !== 'object' || copied === null || Array.isArray(copied)) return copied;
  const { disclosure: _execution, ...declaration } = copied as Record<string, unknown>;
  return Object.freeze(declaration) as T;
}
function retainsVoidDisclosure(profile: FrameworkOpaqueDeclaration['profile']): boolean {
  return profile.kind === 'void' && Object.hasOwn(profile.canonical, 'disclosure');
}

export async function loadOpaqueFileStaging(input: OpaqueFileStagingInput) {
  const { store, artifact, canonicalModels, valueTypes, operations, verify } = input;
  const scope = captureData(input.scope);
  const inventoryOwner = input.inventoryOwner;
  const readInventory = store.readFileReferenceInventory;
  // Legacy storage has no installed opaque payload claim.
  if (typeof readInventory !== 'function') return null;
  const artifactBytes = structural(artifact);
  const modelBytes = structural(canonicalModels), valuesBytes = structural(valueTypes);
  const operationSnapshot = () => structural([...operations].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  const operationBytes = operationSnapshot();
  const current = async (revision?: Revision): Promise<void> => {
    await verify();
    if (structural(artifact) !== artifactBytes || structural(canonicalModels) !== modelBytes ||
        structural(valueTypes) !== valuesBytes || operationSnapshot() !== operationBytes ||
        store.readFileReferenceInventory !== readInventory) refuse('original source/metadata/physical port changed');
    if (revision !== undefined && await store.readRevision() !== revision) refuse('original physical checkpoint moved');
  };
  await current();
  const installed = await readInventory.call(store, inventoryOwner);
  await current();
  if (installed === null) return null;
  const installedBytes = structural(installed);
  const refresh = async (revision: Revision): Promise<void> => {
    await current(revision);
    const observed = await readInventory.call(store, inventoryOwner);
    await current(revision);
    if (structural(observed) !== installedBytes) refuse('installed original declaration inventory changed');
  };
  if (!equal(installed.authority, store.fileRetirementAuthority) || installed.authority.app !== scope.app ||
      installed.authority.receiver.app !== scope.app || installed.authority.receiver.owner !== scope.owner ||
      installed.authority.receiver.team !== scope.owner || installed.inventory.owner !== inventoryOwner) {
    refuse('installed inventory differs from the original source owner');
  }
  const sets = installed.inventory.opaqueDeclarationSets;
  if (sets === undefined) refuse('installed original opaque declarations are incomplete');
  const selectedId = input.declarationSetId ?? `${installed.inventory.snapshotId}:declarations`;
  const original = sets.find(set => set.id === selectedId);
  if (original === undefined) refuse('original declaration set is absent');
  const boundSets = bindOpaqueFileDeclarations([original], (set: FrameworkOpaqueDeclarationSet) => {
    if (!equal(set.inventory, { owner: installed.inventory.owner, snapshotId: installed.inventory.snapshotId,
      digest: installed.inventory.digest }) || !equal(set.snapshot, installed.snapshot) ||
        !equal(set.sources, artifact.sources) || !equal(set.canonicalModels, canonicalModels) ||
        !equal(set.artifactModels, artifact.models) || !equal(set.valueTypes, valueTypes)) {
      refuse('installed declaration closure differs from the genuine current load');
    }
    for (const declaration of set.declarations) {
      const source = declaration.source.source;
      // A SEND declaration retains the Compiler's original logical module.
      // Its actual owning callable identifies the physical emitted module.
      const from = declaration.source;
      const owners = from.kind === 'send-guard' ?
        artifact.callables.filter(callable => callable.id === from.owner) : [];
      if (declaration.source.kind === 'send-guard' && owners.length !== 1) refuse('send guard lacks its exact original callable owner');
      const emitted = artifact.modules.filter(module => module.path ===
        (declaration.source.kind === 'send-guard' ? owners[0]!.module : source.module));
      if (emitted.length !== 1 || !emitted[0]!.map?.sources.includes(source.path) ||
          artifact.sources.filter(candidate => candidate.path === source.path && candidate.sha256 === source.sha256).length !== 1) {
        refuse('declaration lacks exact original module/source correspondence');
      }
    }
  });
  const bound = boundSets.get(selectedId);
  if (bound === undefined) refuse('owning declaration binding is absent');
  const set = bound.declarationSet;
  const event = (name: string): Extract<FrameworkOpaqueEventDeclaration, { kind: 'declared-event' }> => {
    const matches = set.declarations.filter(declaration => declaration.id === `${name}:event-inputs` &&
      declaration.source.kind === 'event' && declaration.source.event === name && declaration.profile.kind === 'inputs');
    if (matches.length !== 1) refuse('event has no exact original input declaration');
    return Object.freeze({ kind: 'declared-event', source: matches[0]!.source.source,
      event: name, inputsDeclarationId: matches[0]!.id });
  };
  const completion = (name: string, providerSource: string, binding: string, from: string):
    Extract<FrameworkOpaqueEventDeclaration, { kind: 'standard-completion' }> => {
    const declared = event(name);
    const inputs = set.declarations.find(value => value.id === `${name}:provider-inputs`);
    const result = set.declarations.find(value => value.id === `${name}:provider-result`);
    if (inputs?.source.kind !== 'delivery' || inputs.source.context.kind !== 'capability' ||
        inputs.profile.kind !== 'inputs' || result?.source.kind !== 'delivery' ||
        result.profile.kind !== 'provider-result' || !equal(inputs.source, result.source) ||
        !equal(inputs.source.source, declared.source) ||
        providerSource !== `${inputs.source.context.canonical.capability}.${inputs.source.context.canonical.operation}`) {
      refuse('completion lacks its exact installed provider request/result declaration');
    }
    return captureData({ kind: 'standard-completion', source: declared.source, event: name,
      providerSource, binding, from, inputsDeclarationId: declared.inputsDeclarationId,
      sourceInputsDeclarationId: inputs.id, resultDeclarationId: result.id, delivery: inputs.source.context });
  };
  const checkedCallable = (id: string): {
    actual: CompileArtifact['callables'][number];
    operation: NonNullable<ReturnType<typeof operations.get>>;
    inputs: FrameworkOpaqueDeclaration;
    result: FrameworkOpaqueDeclaration;
    source: CallableDeclarationSource;
  } => {
    const actual = artifact.callables.filter(candidate => candidate.id === id);
    const operation = operations.get(id);
    const inputs = set.declarations.find(declaration => declaration.id === `${id}:inputs`);
    const result = set.declarations.find(declaration => declaration.id === `${id}:result`);
    if (actual.length !== 1 || operation === undefined || inputs?.source.kind !== 'callable' ||
        inputs.profile.kind !== 'inputs' || result?.source.kind !== 'callable' ||
        !['result', 'void'].includes(result.profile.kind) || !equal(inputs.source.callable, actual[0]) ||
        !equal(result.source, inputs.source) || !equal(inputs.profile.canonical, operation.canonical.inputs) ||
        !equal(inputs.profile.artifact, operation.artifact.inputs.fields) ||
        !equal(result.profile.canonical, retainsVoidDisclosure(result.profile) ?
          operation.canonical.result : resultDeclaration(operation.canonical.result)) ||
        !equal(result.profile.artifact, retainsVoidDisclosure(result.profile) ?
          operation.artifact.result : resultDeclaration(operation.artifact.result))) {
      refuse('callable lacks its complete genuine input/result declaration');
    }
    return { actual: actual[0]!, operation, inputs, result, source: inputs.source as CallableDeclarationSource };
  };
  const callable = (id: string): FrameworkOpaqueCallable => {
    const { actual, operation, result, source } = checkedCallable(id);
    // This nongrant header must match the installed File declaration exactly.
    // The full execution descriptors remain in the independently checked
    // operation snapshot. Old installed full-void profiles keep their shape.
    if (result.profile.kind === 'result' && (operation.canonical.result === undefined || operation.artifact.result === undefined)) {
      refuse('nonvoid callable lacks its original result');
    }
    const slimResult = !retainsVoidDisclosure(result.profile);
    const canonical = slimResult ? Object.freeze({ ...operation.canonical,
      result: resultDeclaration(operation.canonical.result!) }) : operation.canonical;
    const descriptor = slimResult ? Object.freeze({ ...operation.artifact,
      result: resultDeclaration(operation.artifact.result!) }) : operation.artifact;
    return Object.freeze({ source: source.source, callable: actual, canonical,
      artifact: descriptor, resultDeclarationId: result.id });
  };
  const sendInputs = (owner: string, target: string): { readonly caller: FrameworkOpaqueCallable; readonly inputsDeclarationId: string } => {
    const caller = callable(owner);
    const matches = set.declarations.filter(declaration => declaration.id === `${owner}:send:${target}:inputs` &&
      declaration.profile.kind === 'inputs' && declaration.source.kind === 'delivery' &&
      declaration.source.context.kind === 'capability' && equal(declaration.source.source, caller.source) &&
      `${declaration.source.context.canonical.capability}.${declaration.source.context.canonical.operation}` === target);
    if (matches.length !== 1) refuse('SEND inputs lack their exact original provider declaration');
    return Object.freeze({ caller, inputsDeclarationId: matches[0]!.id });
  };
  const sendGuard = (guard: ScenarioReceiptSendGuard, profile?: Extract<FrameworkOpaqueDeclarationSet['declarations'][number]['profile'], { kind: 'inputs' }>): {
    readonly declaration: FrameworkOpaqueSendGuardDeclaration; readonly inputsDeclarationId: string;
  } => {
    // The event field proof governs source-stage SEND capture. The retained
    // Work declaration has the historical guard/typed-input census only.
    const { eventSource: _eventSource, typedEventSource: _typedEventSource, ...original } = captureData(guard);
    const matches = set.declarations.filter(candidate => candidate.source.kind === 'send-guard' &&
      candidate.profile.kind === 'inputs' && equal(candidate.source, { kind: 'send-guard', ...original }));
    if (matches.length !== 1 || matches[0]!.source.kind !== 'send-guard') refuse('send guard lacks its exact installed original lexical input declaration');
    if (profile !== undefined && !equal(matches[0]!.profile, profile)) refuse('guard typed census differs from the original emitted declaration');
    const { kind: _kind, ...declaration } = matches[0]!.source;
    return Object.freeze({ declaration: Object.freeze(declaration), inputsDeclarationId: matches[0]!.id });
  };
  const checkDeliveryTarget = (model: string, field: string, original: ScenarioReceiptDeliveryOriginFrame['send']) => {
    const models = artifact.models?.filter(candidate => candidate.name === model);
    const canonical = canonicalModels.filter(candidate => candidate.name === model);
    const fields = models?.length === 1 ? models[0]!.fields.filter(candidate => candidate.name === field) : [];
    const authored = fields?.length === 1 ? fields[0]!.field : undefined;
    const checked = canonical.length === 1 ? canonical[0]!.fields[field]?.delivery : undefined;
    if (authored?.kind !== 'delivery' || checked === undefined || !equal(authored, checked) ||
        original.target !== `${checked.capability}.${checked.operation}`) refuse('delivery lacks its exact original model/field/target declaration');
    return { checked, authored };
  };
  const findDeliveryDeclaration = (caller: FrameworkOpaqueCallable,
    target: ReturnType<typeof checkDeliveryTarget>) => {
    const { checked, authored } = target;
    const matches = set.declarations.filter(candidate => candidate.source.kind === 'delivery' &&
      // Multiple original callables share this emitted module/source pair.
      // Keep the installed result declaration issued for THIS exact caller.
      candidate.id.startsWith(`${caller.callable.id}:delivery:`) &&
      candidate.profile.kind === 'provider-result' && equal(candidate.source.source, caller.source) &&
      equal(candidate.source.context.canonical, checked) && equal(candidate.source.context.artifact, authored) &&
      equal(candidate.profile.canonical, checked.result) && equal(candidate.profile.artifact, authored.result));
    if (matches.length !== 1 || matches[0]!.source.kind !== 'delivery') refuse('delivery lacks its complete installed original provider result declaration');
    return { match: matches[0]!, profile: matches[0]!.source.context };
  };
  const buildDeliveryDeclaration = (profile: ReturnType<typeof findDeliveryDeclaration>['profile'],
    original: ScenarioReceiptDeliveryOriginFrame['send'],
    generation: ReturnType<typeof dispatchGenerationTargetProfile>): FrameworkOpaqueDeliveryContext => {
    if (profile.kind !== 'generation-profile') return profile;
    if (generation?.role !== 'original') refuse('static Generation profile requires its original Work target');
    // State supplies the actual SEND/frame request. Its receipt producer
    // verifies this instance against that original binding/target and owner.
    const request = 'intentId' in original ? original.arguments : own(original, 'request');
    const value = own(own(request, 'arguments'), 'value');
    const source = own(value, 'source'), revision = own(value, 'revision');
    if (typeof source !== 'string' || source === '' || typeof revision !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(revision)) refuse('actual original Generation request identity required');
    return captureData({ kind: 'generation', canonical: profile.canonical,
      artifact: profile.artifact, request: { source, revision } });
  };
  const assertDeclarationCorrelation = (declaration: FrameworkOpaqueDeliveryContext,
    checked: ReturnType<typeof checkDeliveryTarget>['checked'],
    original: ScenarioReceiptDeliveryOriginFrame['send'],
    generation: ReturnType<typeof dispatchGenerationTargetProfile>): void => {
    if ('judgment' in checked ? declaration.kind !== 'judgment' :
        generation !== null ? declaration.kind !== 'generation' : declaration.kind !== 'capability') {
      refuse('delivery lacks its owning original context variant');
    }
    if (declaration.kind === 'generation') {
      const request = 'intentId' in original ? original.arguments : own(original, 'request');
      const value = own(own(request, 'arguments'), 'value');
      if (!equal(declaration.request, { source: own(value, 'source'), revision: own(value, 'revision') })) {
        refuse('delivery generation correlation differs from its original installed request');
      }
    } else if (declaration.kind === 'judgment') {
      const request = 'intentId' in original ? original.arguments : own(original, 'request');
      const judgment = own(request, 'judgment');
      if (!equal(declaration.specification, own(judgment, 'specification')) || !equal(declaration.order, own(judgment, 'order'))) {
        refuse('delivery Judgment differs from its original frozen specification');
      }
    }
  };
  const delivery = (model: string, field: string, send: ScenarioReceiptDeliveryOriginFrame['send']): {
    readonly declaration: FrameworkOpaqueDeliveryContext; readonly resultDeclarationId: string;
  } => {
    const original = captureData(send);
    const caller = callable(original.operation);
    const target = checkDeliveryTarget(model, field, original);
    const generation = dispatchGenerationTargetProfile(original.target);
    const { match, profile } = findDeliveryDeclaration(caller, target);
    const declaration = buildDeliveryDeclaration(profile, original, generation);
    assertDeclarationCorrelation(declaration, target.checked, original, generation);
    return Object.freeze({ declaration, resultDeclarationId: match.id });
  };
  const occurrences = (projection: FrameworkOpaqueValueProjection, value: unknown, binding?: FrameworkFilePayloadOrigin) =>
    resolveOpaqueFileProjection(bound, projection, value, binding);
  const own = (value: unknown, key: string | number): unknown => {
    if (typeof value !== 'object' || value === null) refuse('original stored own value required');
    const property = Object.getOwnPropertyDescriptor(value, String(key));
    if (property === undefined || !('value' in property)) refuse('original stored own field required');
    return property.value;
  };
  const assertSourceRow = (source: RetainedOpaqueFileSource, row: StoredRow | null): StoredRow => {
    if (row === null || !equal(row, source.row) || !equal(own(row.data, source.field === 'queuePayload' ? 'queuePayloadOrigin' : source.field === 'sendInputs' ? 'sendInputsOrigin' : 'filePayloadOrigin'), source.binding)) {
      refuse('retained source is not its exact current physical row/header');
    }
    return row;
  };
  const assertSourceHeader = (source: RetainedOpaqueFileSource, row: StoredRow,
    header: RetainedOpaqueFileSource['binding']): void => {
    if (header.slot.model !== source.model || header.slot.id !== row.id || header.slot.created !== row.created ||
        header.slot.createdBy !== row.createdBy || header.slot.field !== source.field ||
        !equal(header.scope, scope) || header.declarationSetId !== selectedId || !equal(header.inventory, set.inventory)) {
      refuse('retained source differs from its original slot/lifetime/scope');
    }
  };
  const collectSourceFiles = async (source: RetainedOpaqueFileSource, row: StoredRow,
    header: RetainedOpaqueFileSource['binding']): Promise<readonly RetainedFinalizedFile[]> => {
    validateOpaqueFileOrigin(bound, header);
    const producers = [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER].filter(producer =>
      producer.models.some(model => model.model === source.model));
    if (producers.length !== 1) refuse('retained source requires one exact owning framework producer');
    const resolve = producers[0]!.resolveOpaqueField;
    if (typeof resolve !== 'function') refuse('owning framework opaque resolver is absent');
    const resolved = resolve(source.model, row, source.field, { installed, binding: header });
    if (!equal(resolved.binding, header)) refuse('owning projection changed the original source binding');
    const payload = own(row.data, source.field);
    const found = resolved.values.flatMap(projection => {
      let value = payload;
      for (const part of projection.path) value = own(value, part);
      return occurrences(projection, value, header).map(item => ({ path: [...projection.path, ...item.path], ref: item.ref }));
    });
    if (found.length !== header.files.length) refuse('retained source lacks complete typed File correspondence');
    const paths = new Set<string>();
    for (const item of found) {
      const key = structural(item.path);
      if (paths.has(key)) refuse('retained source repeats a typed File position');
      paths.add(key);
      const matches = header.files.filter(saved => equal(saved.path, item.path));
      if (matches.length !== 1 || matches[0]!.file.ref !== item.ref ||
          matches[0]!.file.receiver.app !== scope.app || matches[0]!.file.receiver.team !== scope.owner ||
          matches[0]!.file.receiver.owner !== scope.owner) refuse('retained File path/ref/receiver differs from its genuine source');
    }
    return header.files.map(item => item.file);
  };
  const checkSource = async (source: RetainedOpaqueFileSource, revision: Revision): Promise<readonly RetainedFinalizedFile[]> => {
    await current(revision);
    const loadedRow = await store.load(source.model, source.row.id);
    const captured = loadedRow === null ? null : captureData(loadedRow);
    await current(revision);
    const row = assertSourceRow(source, captured);
    const header = source.binding;
    assertSourceHeader(source, row, header);
    return collectSourceFiles(source, row, header);
  };
  const revalidateSource = async (source: RetainedOpaqueFileSource, revision: Revision,
    files?: CanonicalFileBinding): Promise<void> => {
    source = captureSource(source);
    const saved = await checkSource(source, revision);
    if (saved.length !== 0 && files === undefined) refuse('retained source File requires its genuine observer');
    for (const file of saved) {
      const observation = await observeRetainedCanonicalFile(files!, file, async () => { await checkSource(source, revision); });
      await checkSource(source, revision);
      if (observation === null) refuse('retained source File is no longer available under its original receiver');
    }
  };
  /** Read one exact typed occurrence through the genuine physical receiver.
   * A raw outbox/File ref or copied header without its current source row is
   * insufficient. File bytes never replace the source's complete census. */
  const readSourceFile = async (request: { readonly source: RetainedOpaqueFileSource; readonly revision: Revision;
    readonly path: readonly (string | number)[]; readonly ref: string; readonly maxBytes: number },
    files: CanonicalFileBinding | undefined): Promise<Uint8Array | null> => {
    const captured = captureData(request);
    const { source, revision, path, ref, maxBytes } = captured;
    if (files === undefined || typeof ref !== 'string' || ref === '' || !Array.isArray(path) ||
        path.length > 32 || path.some(part => typeof part === 'string' ? part === '' : !Number.isSafeInteger(part) || part < 0) ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1) refuse('source File read requires bounded exact selectors');
    await checkSource(source, revision);
    const matches = source.binding.files.filter(item => equal(item.path, path) && item.file.ref === ref);
    if (matches.length !== 1) refuse('source File read must select its exact typed occurrence');
    const bytes = await readRetainedCanonicalFile(files, matches[0]!.file, maxBytes,
      async () => { await checkSource(source, revision); });
    await checkSource(source, revision);
    return bytes;
  };
  /** Only the original retained outbox request may consume its SEND input File. */
  const readSendInputFile = async (request: { readonly intent: OutboxIntent; readonly revision: Revision;
    readonly path: readonly (string | number)[]; readonly ref: string; readonly maxBytes: number },
    files: CanonicalFileBinding | undefined): Promise<Uint8Array | null> => {
    const captured = captureData(request);
    const readOriginal = async (): Promise<RetainedOpaqueFileSource> => {
      await current(captured.revision);
      const retained = await store.outboxGet(captured.intent.intentId);
      const loaded = await store.load(WORK_DISPATCH_MODEL, captured.intent.intentId as RecordId);
      await current(captured.revision);
      if (retained === null || !['pending', 'dispatched'].includes(retained.status) ||
          !equal(retained.intent, captured.intent) || loaded === null || loaded.archivedAt !== null) refuse('SEND File requires its exact retained outbox and current dispatch');
      const row = captureData(loaded), { binding } = readRetainedSendInputs(row, captured.intent);
      return { model: WORK_DISPATCH_MODEL, row, field: 'sendInputs', binding };
    };
    const source = await readOriginal();
    const bytes = await readSourceFile({ source, revision: captured.revision, path: captured.path,
      ref: captured.ref, maxBytes: captured.maxBytes }, files);
    if (!equal(source, await readOriginal())) refuse('SEND File source changed while reading');
    return bytes;
  };
  const capturePrepareRequest = (request: PrepareFileRequest): PrepareFileRequest => {
    // Pin only persisted metadata; binding/identity and observations keep their actual issuers.
    const captured = captureData({ expectedRevision: request.expectedRevision, model: request.model,
      row: request.row, field: request.field, scope: request.scope, origin: request.origin,
      projection: request.projection, value: request.value, ...(request.additional === undefined ? {} : { additional: request.additional }) });
    const retainedSource = request.retainedSource === undefined ? undefined : captureSource(request.retainedSource);
    return { ...captured, identity: request.identity, ...(request.files === undefined ? {} : { files: request.files }),
      ...(retainedSource === undefined ? {} : { retainedSource }) };
  };
  const collectPrepareOccurrences = (request: PrepareFileRequest) => {
    return [{ projection: request.projection, value: request.value }, ...request.additional ?? []].flatMap(entry => {
      const original = ('retainedSource' in entry ? entry.retainedSource : undefined) ?? request.retainedSource;
      const transferredGuard = entry.projection.kind === 'inputs' && original?.binding.origin.kind === 'send-guard' &&
        original.field === 'sourceGuard' && entry.projection.declarationId === original.binding.origin.inputsDeclarationId &&
        equal(entry.projection.path, ['origin', 'dispatch', 'sourceGuard', 'inputs']);
      if (transferredGuard && !equal(entry.value, own(own(original!.row.data, 'sourceGuard'), 'inputs'))) refuse('copied guard inputs differ from their exact retained source');
      const projection = transferredGuard ? { ...entry.projection, path: ['inputs'] } : entry.projection;
      return occurrences(projection, entry.value, original?.binding).map(occurrence => ({ ...occurrence, path: [...entry.projection.path, ...occurrence.path], source: original }));
    });
  };
  const observePrepareFiles = async (found: PrepareOccurrence[],
    sources: Map<RetainedOpaqueFileSource, readonly RetainedFinalizedFile[]>,
    files: CanonicalFileBinding | undefined, observe: CanonicalFileBinding['observe'] | undefined,
    request: PrepareFileRequest): Promise<{ path: readonly (string | number)[]; observation: unknown }[]> => {
    const observations: { path: readonly (string | number)[]; observation: unknown }[] = [];
    for (const occurrence of found) {
      const retained = occurrence.source === undefined ? undefined : sources.get(occurrence.source);
      let observation: unknown;
      if (retained === undefined) {
        if (files!.observe !== observe) refuse('original receiving observer changed');
        observation = await observe!.call(files, occurrence.ref, request.identity, scope.app);
      } else {
        const matches = retained.filter(saved => saved.ref === occurrence.ref);
        if (matches.length === 0 || matches.some(saved => !equal(saved, matches[0]))) {
          refuse('target File has no unique genuine original source facts');
        }
        observation = await observeRetainedCanonicalFile(files!, matches[0]!, async () => {
          await checkSource(occurrence.source!, request.expectedRevision);
        });
        await checkSource(occurrence.source!, request.expectedRevision);
      }
      await current(request.expectedRevision);
      if (retained === undefined && files!.observe !== observe || observation === null) refuse('original File observation refused or changed');
      observations.push({ path: occurrence.path, observation });
    }
    return observations;
  };
  const prepare = async (request: {
    readonly expectedRevision: Revision; readonly model: ModelName; readonly row: StoredRow; readonly field: string;
    readonly scope: FrameworkFilePayloadOrigin['scope']; readonly origin: FrameworkFilePayloadOrigin['origin'];
    readonly projection: FrameworkOpaqueValueProjection; readonly value: unknown;
    readonly additional?: ReadonlyArray<{ readonly projection: FrameworkOpaqueValueProjection; readonly value: unknown; readonly retainedSource?: RetainedOpaqueFileSource }>;
    readonly identity: ResolvedIdentity; readonly files?: CanonicalFileBinding;
    readonly retainedSource?: RetainedOpaqueFileSource;
  }): Promise<FrameworkFilePayloadOrigin> => {
    request = capturePrepareRequest(request);
    if (request.scope.app !== scope.app || request.scope.owner !== scope.owner || request.scope.ownerPackage !== scope.ownerPackage) {
      refuse('payload differs from the original source scope');
    }
    // Static Generation projections borrow only the verified original source
    // header. Fresh request/result File enrollment needs its owning producer;
    // an absent original header continues to refuse rather than be fabricated.
    if ((request.additional?.length ?? 0) > 3) refuse('payload exceeds its bounded typed projection join');
    const found = collectPrepareOccurrences(request);
    const files = request.files, observe = found.length === 0 ? undefined : files?.observe;
    if (found.length !== 0 && (files === undefined || found.some(occurrence => occurrence.source === undefined) &&
        (typeof observe !== 'function' || request.identity.actor === null))) {
      refuse('typed File payload requires its genuine authenticated observer');
    }
    await current(request.expectedRevision);
    const sources = new Map<RetainedOpaqueFileSource, readonly RetainedFinalizedFile[]>();
    for (const source of [request.retainedSource, ...found.map(occurrence => occurrence.source)]) {
      if (source !== undefined && !sources.has(source)) sources.set(source, await checkSource(source, request.expectedRevision));
    }
    const observations = await observePrepareFiles(found, sources, files, observe, request);
    const origin = await prepareFrameworkFilePayloadOrigin(store, {
      expectedRevision: request.expectedRevision, inventoryOwner, declarationSetId: selectedId,
      model: request.model, row: request.row, field: request.field, scope: request.scope, origin: request.origin,
      files: observations,
    });
    await current(request.expectedRevision);
    for (const source of sources.keys()) await checkSource(source, request.expectedRevision);
    return origin;
  };
  type PrepareFileRequest = Parameters<typeof prepare>[0];
  type PrepareOccurrence = ReturnType<typeof collectPrepareOccurrences>[number];
  const prepareControl = async (request: {
    readonly expectedRevision: Revision; readonly model: ModelName; readonly row: StoredRow;
    readonly field: string; readonly scope: FrameworkFilePayloadOrigin['scope']; readonly origin: FrameworkFilePayloadOrigin['origin'];
  }): Promise<FrameworkFilePayloadOrigin> => {
    request = captureData(request);
    if (!equal(request.scope, scope)) refuse('control receipt differs from its original source scope');
    await current(request.expectedRevision);
    const origin = await prepareFrameworkFilePayloadOrigin(store, { ...request, inventoryOwner,
      declarationSetId: selectedId, files: [] });
    await current(request.expectedRevision);
    return origin;
  };
  await current();
  return Object.freeze({ installed, set, bound, event, completion, callable, sendGuard, sendInputs, delivery, occurrences, prepare, prepareControl, revalidateSource, readSourceFile, readSendInputFile, refresh });
}
