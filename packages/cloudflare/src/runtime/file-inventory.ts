/** Worker-safe installation of the original compiler/State opaque declaration inventory. */
import type { ArtifactModel, ArtifactOperation, CanonicalModelDescriptor, CanonicalOperationDescriptor, CompileArtifact,
  FileReferenceInventory, FileReferenceStoragePort, FileRetirementAuthority, FrameworkOpaqueDeclaration,
  FrameworkOpaqueDeclarationSet, FrameworkOpaqueValueDefault, ArtifactDeliveryDescriptor, Revision, WireValue, WorkScope } from '@canlang/contracts';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { stableStringify } from '@canlang/state/invocation';
import { dispatchGenerationTargetProfile } from '@canlang/work/kernel/tables';
import { encodeValue } from '@canlang/values';
import type { AssembledModules } from './modules.js';
import { AssemblyCorrespondenceError, assemblerArtifactDataEligible, captureVerifiedAssemblerArtifact, importVerifiedAssemblyModule, verifyAssemblerModuleCapability } from './assembly-verification.js';
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
  /** Soda may reopen unchanged declarations after presentation/module edits.
   * Historical source identities remain installed; live code is verified above. */
  readonly retainUnchangedDeclarations?: boolean;
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
  const addTextBytes = (text: string): void => {
    textBytes += new TextEncoder().encode(text).byteLength;
    if (textBytes > 2_000_000) throw new Error('File retirement declaration text exceeds its finite bounds.');
  };
  const copyArray = (node: object, length: number, depth: number): WireValue => {
    const output: WireValue[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(node, String(index));
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) throw new Error('File retirement requires own declaration array data.');
      output.push(copy(descriptor.value, depth + 1));
    }
    return Object.freeze(output) as unknown as WireValue;
  };
  const copyRecord = (node: object, keys: readonly (string | symbol)[], depth: number): WireValue => {
    const output: Record<string, WireValue> = {};
    for (const key of keys) {
      const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(node, key) : undefined;
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable || typeof key !== 'string') {
        throw new Error('File retirement requires own enumerable declaration data.');
      }
      addTextBytes(key);
      Object.defineProperty(output, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
    }
    return Object.freeze(output);
  };
  const copy = (node: unknown, depth: number): WireValue => {
    if (++nodes > 20_000 || depth > 32) throw new Error('File retirement declaration capture exceeds its finite bounds.');
    if (typeof node === 'bigint') return encodeValue('int', node);
    if (node === null || typeof node === 'boolean') return node;
    if (typeof node === 'string') {
      addTextBytes(node);
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
        return copyArray(node, length, depth);
      }
      return copyRecord(node, keys, depth);
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

type CallableSource = Extract<FrameworkOpaqueDeclaration['source'], { kind: 'callable' }>;

interface ModuleCapture {
  module: string;
  definition: unknown;
  invocations: Readonly<Record<string, WireValue>>;
  events: Readonly<Record<string, WireValue>>;
  capabilities: Readonly<Record<string, WireValue>>;
  sendGuards: Readonly<Record<string, WireValue>>;
}

function captureModuleInvocations(artifact: CompileArtifact, modulePath: string, original: unknown, captures: ModuleCapture[]): void {
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
  captures.push({ module: modulePath, definition: original, invocations: Object.freeze(invocations), events, capabilities: declarationWire(data(original, 'capabilities')) as Readonly<Record<string, WireValue>>, sendGuards: Object.freeze(sendGuards) });
}

function verifyCapturedDeclarations(originalContracts: Readonly<Record<string, WireValue>>,
  definition: unknown, captures: readonly ModuleCapture[]): void {
  if (!equal(originalContracts, declarationWire(data(definition, 'contracts')))) throw new Error('File retirement original contracts changed after capture.');
  for (const captured of captures) {
    if (!equal(captured.capabilities, declarationWire(data(captured.definition, 'capabilities')))) throw new Error('Original capability declarations changed after capture.');
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
}

function resolveCallableOperation(artifact: CompileArtifact, captures: readonly ModuleCapture[],
  loaded: Awaited<ReturnType<typeof loadCanonicalDescriptors>>,
  callable: CompileArtifact['callables'][number]): { source: CallableSource; operation: ArtifactOperation; canonical: CanonicalOperationDescriptor } {
  const emitted = artifact.modules.filter(candidate => candidate.path === callable.module);
  const paths = emitted.length === 1 ? emitted[0]!.map?.sources : undefined;
  // Multi-source closures carry the exact declaring file on the callable;
  // single-source closures keep the legacy module-map resolution.
  const sources = typeof callable.source === 'string' ?
    artifact.sources.filter(source => source.path === callable.source) :
    artifact.sources.filter(source => paths?.includes(source.path));
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
  return { source, operation, canonical };
}

function declareSendGuards(artifact: CompileArtifact, captures: readonly ModuleCapture[],
  callable: CompileArtifact['callables'][number],
  source: CallableSource,
  declarations: FrameworkOpaqueDeclaration[]): void {
  const originalCapture = captures.find(captured => captured.module === callable.module);
  const guarded = originalCapture?.sendGuards[callable.id];
  if (guarded === undefined) return;
  if (callable.id === 'events.observe_venue') {
    const invocation = originalCapture?.invocations[callable.id] as
      { readonly result?: { readonly disclosure?: { readonly observeVenueDecision?: {
        readonly owner: string; readonly sendRule: { readonly rule: string; readonly node: unknown } } } } } | undefined;
    const decision = invocation?.result?.disclosure?.observeVenueDecision;
    const entries = Array.isArray(guarded) ? guarded as Array<Record<string, unknown>> : [];
    const slots = entries.filter(entry => entry['owner'] === callable.id);
    if (decision?.owner !== callable.id || slots.length !== 1 ||
        decision.sendRule.rule !== slots[0]!['rule'] ||
        !equal(decision.sendRule.node, slots[0]!['node'])) {
      throw new Error('Observe venue SEND interval differs from its checked source decision.');
    }
  }
  if (!Array.isArray(guarded) || originalCapture === undefined) throw new Error('Original SEND guard inventory must be complete.');
  const originalPackages = data(originalCapture.definition, 'packages');
  const owningPackage = Object.keys(originalPackages as object).filter(name => callable.id.startsWith(`${name}.`))
    .sort((left, right) => right.length - left.length)[0];
  if (owningPackage === undefined) throw new Error('Original SEND guard lacks its owning lexical package.');
  for (const entry of guarded) {
    assertSendGuard(entry, artifact, callable, source, declarations, owningPackage);
  }
}

function assertSendGuard(entry: unknown, artifact: CompileArtifact,
  callable: CompileArtifact['callables'][number],
  source: CallableSource,
  declarations: FrameworkOpaqueDeclaration[], owningPackage: string): void {
  const guard = entry as unknown as Record<string, unknown>;
  const profile = data(guard, 'inputDeclaration') as FrameworkOpaqueDeclaration['profile'];
  const originalSource = data(guard, 'source') as { path: string; sha256: string; module: string };
  const rule = data(guard, 'rule') as string;
  const rules = artifact.callables.filter(candidate => candidate.kind === 'rule' && candidate.id === rule &&
    candidate.module === callable.module && equal(candidate.member, ['sendWhen', rule]));
  const sourceEvaluation = Object.hasOwn(guard, 'evaluation');
  const expected = ['binding', 'inputDeclaration', 'inputs', 'node', 'owner', 'rule', 'source', 'sourceBinding', 'statement', 'target',
    ...(Object.hasOwn(guard, 'eventSource') ? ['eventSource'] : []), ...(sourceEvaluation ? ['evaluation'] : [])];
  if (!equal(Object.keys(guard).sort(), expected.sort()) || sourceEvaluation && data(guard, 'evaluation') !== 'source' ||
      data(guard, 'owner') !== callable.id || originalSource.path !== source.source.path ||
      originalSource.sha256 !== source.source.sha256 || originalSource.module !== owningPackage ||
      rules.length !== 1 || rules[0]!.inputStyle !== undefined || profile.kind !== 'inputs') {
    throw new Error('Original SEND guard lacks its complete owning Compiler declaration.');
  }
  assertSendSlots(guard, profile, rule, artifact, callable, source, declarations);
}

function assertSendSlots(guard: Record<string, unknown>, profile: FrameworkOpaqueDeclaration['profile'], rule: string,
  artifact: CompileArtifact,
  callable: CompileArtifact['callables'][number],
  source: CallableSource,
  declarations: FrameworkOpaqueDeclaration[]): void {
  const inputs = data(guard, 'inputs') as readonly { name: string; type: import('@canlang/contracts').CanTypeId }[];
  if (profile.kind !== 'inputs' || profile.canonical.length !== inputs.length || profile.artifact.length !== inputs.length || inputs.some((input, index) =>
      profile.canonical[index]?.name !== input.name || profile.artifact[index]?.name !== input.name ||
      profile.artifact[index]?.valueType !== input.type || profile.canonical[index]?.required !== true ||
      profile.artifact[index]?.required !== true || ['default', 'computedDefault'].some(key =>
      Object.hasOwn(profile.canonical[index]!, key) || Object.hasOwn(profile.artifact[index]!, key)))) throw new Error('Original SEND slots must retain their complete required typed declaration.');
  let node = data(guard, 'node') as { start: number; end: number };
  if (callable.id === 'invoice.issue') {
    const operations = artifact.operations?.filter(operation => operation.name === callable.id && operation.kind === 'scenario');
    const decision = operations?.[0]?.result?.disclosure?.invoiceIssueDecision as
      { readonly owner: string; readonly sendRule: { readonly rule: string; readonly node: unknown } } | undefined;
    if (operations?.length !== 1 || decision?.owner !== callable.id || decision.sendRule.rule !== rule ||
        !equal(decision.sendRule.node, node)) {
      throw new Error('Invoice issue SEND interval differs from its checked source decision.');
    }
    node = { start: data(node, 'start') as number, end: data(node, 'end') as number };
  }
  if (callable.id === 'events.observe_venue' || callable.id === 'success.renewal_due') {
    node = { start: data(node, 'start') as number, end: data(node, 'end') as number };
  }
  declarations.push({ id: `${rule}:send-inputs`, source: { kind: 'send-guard', rule,
    ...(Object.hasOwn(guard, 'evaluation') ? { evaluation: 'source' as const } : {}),
    source: source.source, owner: callable.id, node,
    binding: data(guard, 'binding') as string, target: data(guard, 'target') as string, inputs }, profile });
}

function declareCallableResult(
  callable: CompileArtifact['callables'][number],
  source: CallableSource,
  canonical: CanonicalOperationDescriptor, operation: ArtifactOperation,
  declarations: FrameworkOpaqueDeclaration[], retainFullVoidDisclosure: boolean): void {
  if (canonical.result === undefined && operation.result === undefined) return;
  if (canonical.result === undefined || operation.result === undefined || !equal(canonical.result, operation.result)) {
    throw new Error('File retirement original callable results disagree.');
  }
  declarations.push({ id: `${callable.id}:result`, source,
    // Fresh File profiles need the type alone; the verified loaded descriptor
    // owns the execution plan. Reopened legacy profiles retain their full plan.
    profile: canonical.result.type === 'void' ? { kind: 'void',
      canonical: retainFullVoidDisclosure ? { ...canonical.result, type: 'void' } : { type: 'void' },
      artifact: retainFullVoidDisclosure ? { ...operation.result, type: 'void' } : { type: 'void' } } :
      // The opaque closure binds a result's File profile from its type
      // alone; the disclosure plan stays with the loaded descriptor and
      // is not persisted a second time inside this inventory.
      { kind: 'result', canonical: { type: canonical.result.type },
        artifact: { type: operation.result.type } } });
}

/** Provider input profiles use the same checked field loader as completion
 * requests. They belong to this actual callable/source, not a fabricated
 * scenario signature or a synthetic true SEND guard. */
function providerInputProfile(artifact: CompileArtifact, loaded: Awaited<ReturnType<typeof loadCanonicalDescriptors>>,
  target: string, fields: unknown): Extract<FrameworkOpaqueDeclaration['profile'], { kind: 'inputs' }> {
  if (!Array.isArray(fields)) throw new Error('Provider inputs require complete original catalog fields.');
  const descriptor: ArtifactOperation = { name: target, kind: 'scenario', description: '',
    inputs: { fields: fields as ArtifactOperation['inputs']['fields'] } };
  const request = loaded.producers.registry.loadArtifactDescriptors({ ...artifact, operations: [descriptor] }, { by: () => 'owner' });
  const canonical = data(request.registry.get(target), 'descriptor') as CanonicalOperationDescriptor;
  return { kind: 'inputs', canonical: canonical.inputs, artifact: descriptor.inputs.fields };
}
function declareProviderSendInputs(artifact: CompileArtifact, captures: readonly ModuleCapture[],
  loaded: Awaited<ReturnType<typeof loadCanonicalDescriptors>>, callable: CompileArtifact['callables'][number],
  source: CallableSource, declarations: FrameworkOpaqueDeclaration[]): void {
  const captured = captures.find(value => value.module === callable.module);
  if (captured === undefined) throw new Error('Provider inputs require their original callable module.');
  for (const [capability, declared] of Object.entries(captured.capabilities)) {
    if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) throw new Error('Provider declaration is invalid.');
    if (!Object.hasOwn(declared, 'operations')) continue;
    const operations = data(declared, 'operations');
    if (typeof operations !== 'object' || operations === null || Array.isArray(operations)) throw new Error('Provider operations are invalid.');
    for (const [name, operation] of Object.entries(operations)) {
      // Legacy declarations without released catalog fields do not gain a
      // new retained input consumer. Retained File reads then refuse.
      if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) throw new Error('Provider operation is invalid.');
      if (!Object.hasOwn(operation, 'inputFields') && !Object.hasOwn(operation, 'delivery')) continue;
      if (!Object.hasOwn(operation, 'inputFields') || !Object.hasOwn(operation, 'delivery')) throw new Error('Provider inputs require their complete original catalog declaration.');
      const target = `${capability}.${name}`, delivery = data(operation, 'delivery') as ArtifactDeliveryDescriptor;
      if (delivery.capability !== capability || delivery.operation !== name) throw new Error('Provider input target differs from its catalog.');
      declarations.push({ id: `${callable.id}:send:${target}:inputs`,
        source: { kind: 'delivery', source: source.source,
          context: { kind: 'capability', canonical: delivery, artifact: delivery } },
        profile: providerInputProfile(artifact, loaded, target, data(operation, 'inputFields')) });
    }
  }
}

function declareCallable(artifact: CompileArtifact, captures: readonly ModuleCapture[],
  loaded: Awaited<ReturnType<typeof loadCanonicalDescriptors>>,
  callable: CompileArtifact['callables'][number], declarations: FrameworkOpaqueDeclaration[],
  models: readonly ArtifactModel[], legacyVoidResultIds: ReadonlySet<string>): void {
  if (callable.kind !== 'operation' && callable.kind !== 'handler') return;
  const { source, operation, canonical } = resolveCallableOperation(artifact, captures, loaded, callable);
  declarations.push({ id: `${callable.id}:inputs`, source,
    profile: { kind: 'inputs', canonical: canonical.inputs, artifact: operation.inputs.fields } });
  declareSendGuards(artifact, captures, callable, source, declarations);
  declareProviderSendInputs(artifact, captures, loaded, callable, source, declarations);
  declarations.push(...nativeCapabilityResultDeclarations(source, loaded.models, models));
  declareCallableResult(callable, source, canonical, operation, declarations,
    legacyVoidResultIds.has(`${callable.id}:result`));
}

function declareModuleEvents(artifact: CompileArtifact, captures: readonly ModuleCapture[],
  loaded: Awaited<ReturnType<typeof loadCanonicalDescriptors>>, declarations: FrameworkOpaqueDeclaration[]): void {
  const events = new Set<string>();
  for (const captured of captures) {
    for (const event of Object.keys(captured.events)) {
      assertModuleEvent(artifact, loaded, captured, event, events, declarations);
    }
  }
}

function assertModuleEvent(artifact: CompileArtifact,
  loaded: Awaited<ReturnType<typeof loadCanonicalDescriptors>>, captured: ModuleCapture,
  event: string, events: Set<string>, declarations: FrameworkOpaqueDeclaration[]): void {
  const original = data(captured.events, event);
  // The Compiler supplies exact owning input fields for declared events and
  // checked standard completion envelopes. This schema profile grants no source admission.
  if (!Object.hasOwn(original as object, 'inputFields')) return;
  if (events.has(event)) throw new Error('File retirement requires one exact original event module.');
  events.add(event);
  const emitted = artifact.modules.filter(candidate => candidate.path === captured.module);
  const paths = emitted.length === 1 ? emitted[0]!.map?.sources : undefined;
  // Multi-source closures carry the exact declaring file on the event;
  // single-source closures keep the legacy module-map resolution.
  const declared = (original as Record<string, unknown>)['source'];
  const sources = typeof declared === 'string' ?
    artifact.sources.filter(source => source.path === declared) :
    artifact.sources.filter(source => paths?.includes(source.path));
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


/** Standard carriers retain their catalog request/result declarations even when
 * the author's delivery locator is text rather than a stored delivery field. */
function declareStandardCompletions(artifact: CompileArtifact, captures: readonly ModuleCapture[],
  loaded: Awaited<ReturnType<typeof loadCanonicalDescriptors>>, declarations: FrameworkOpaqueDeclaration[]): void {
  for (const completion of loaded.standardCompletions?.values() ?? []) {
    const callable = artifact.callables.find(value => value.id === completion.routes[0]?.handler);
    const captured = captures.find(value => value.module === callable?.module);
    const event = declarations.find(value => value.id === `${completion.event}:event-inputs`);
    if (captured === undefined || event?.source.kind !== 'event') throw new Error('Completion lacks its original event/source declaration.');
    const split = completion.source.lastIndexOf('.');
    const operation = data(data(data(captured.capabilities, completion.source.slice(0, split)), 'operations'), completion.source.slice(split + 1));
    const fields = data(operation, 'inputFields');
    const delivery = data(operation, 'delivery') as ArtifactDeliveryDescriptor;
    if (!Array.isArray(fields) || delivery.capability !== completion.source.slice(0, split) ||
        delivery.operation !== completion.source.slice(split + 1) || delivery.result.name !== completion.resultType) {
      throw new Error('Completion lacks its original bound catalog request/result descriptor.');
    }
    const profile = providerInputProfile(artifact, loaded, completion.source, fields);
    const source: FrameworkOpaqueDeclaration['source'] = { kind: 'delivery', source: event.source.source,
      context: { kind: 'capability', canonical: delivery, artifact: delivery } };
    declarations.push({ id: `${completion.event}:provider-inputs`, source,
      profile },
    { id: `${completion.event}:provider-result`, source,
      profile: { kind: 'provider-result', canonical: delivery.result, artifact: delivery.result } });
  }
}

/** True when the owner key prefixes at least one artifact model. Serving
 * workers pass the app name as the scope owner, which owns zero models. */
function ownerPrefixesModels(artifactModels: readonly { readonly name: string }[], ownerPackage: string): boolean {
  return artifactModels.some(model => model.name.split('.')[0] === ownerPackage);
}

/** Installs once, or verifies the persisted original closure on reopen. */
export async function installNativeFileInventory(input: NativeFileInventoryInput) {
  // Capture physical configuration before the first yield; all composed owners
  // retain one original source closure and the same literal storage binding.
  const captured = { ...input, scope: immutable(input.scope), authority: immutable(input.authority) };
  const prepared = await prepareNativeFileInventory(captured);
  if (!ownerPrefixesModels(prepared.artifact.models ?? [], captured.scope.ownerPackage)) {
    // App-wide install: the scope key owns zero models (serving workers pass
    // the app name). One inventory covers every model so a fresh install
    // censes pre-existing rows against complete coverage. Per-owner
    // subdivision cannot work here: each install validates all live rows
    // against coverage merged so far, so multi-package rows refuse no matter
    // the install order — and keeping per-owner installs alongside the
    // app-wide coverage would collide on shared model declarations.
    const installed = await installNativeFileInventoryForOwner(captured, prepared);
    await installed.verifyCurrent();
    return installed;
  }
  const owners = new Set([captured.scope.ownerPackage,
    ...(prepared.artifact.models ?? []).map(model => model.name.split('.')[0]!).filter(Boolean)]);
  let selected: Awaited<ReturnType<typeof installNativeFileInventoryForOwner>> | undefined;
  for (const ownerPackage of owners) {
    const installed = await installNativeFileInventoryForOwner({ ...captured, scope: { ...captured.scope, ownerPackage } }, prepared);
    if (ownerPackage === captured.scope.ownerPackage) selected = installed;
  }
  if (selected === undefined) throw new Error('Original File inventory owner is absent.');
  await selected.verifyCurrent();
  return selected;
}

/** Pure source declarations are shared only within this installation call.
 * Storage snapshots, owner admission and revision fences remain per owner. */
async function prepareNativeFileInventory(input: NativeFileInventoryInput) {
  const { artifact: callerArtifact, asm, store, verifyOwner } = input;
  const scope = immutable(input.scope), authority = immutable(input.authority);
  assemblerArtifactDataEligible(callerArtifact);
  const artifactJson = JSON.stringify(callerArtifact);
  const artifact = await captureVerifiedAssemblerArtifact(asm, callerArtifact);
  const assertCallerData = (): void => {
    if (!assemblerArtifactDataEligible(callerArtifact) && artifact !== callerArtifact) {
      throw new AssemblyCorrespondenceError('importVerifiedAssemblyModule: artifact differs from assembled source');
    }
  };
  const assertCallerArtifact = (): void => {
    assertCallerData();
    if (JSON.stringify(callerArtifact) !== artifactJson) {
      throw new AssemblyCorrespondenceError('importVerifiedAssemblyModule: artifact differs from assembled source');
    }
  };
  const importOriginalModule = async (path: string): Promise<unknown> => {
    assertCallerArtifact();
    const imported = await importVerifiedAssemblyModule(asm, path, artifact);
    assertCallerArtifact();
    return imported;
  };
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(artifactJson));
  const digest = `sha256:${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  let verifyDeclarations = (): void => {};
  const verifyCurrent = async (): Promise<void> => {
    verifyDeclarations();
    assertCallerArtifact();
    await verifyAssemblerModuleCapability(asm, artifact);
    assertCallerArtifact();
    await verifyOwner();
    assertCallerData();
    verifyDeclarations();
    if (JSON.stringify(callerArtifact) !== artifactJson || !equal(store.fileRetirementAuthority, authority) ||
        authority.app !== scope.app ||
        authority.receiver.app !== scope.app || authority.receiver.owner !== scope.owner || authority.receiver.team !== scope.owner) {
      throw new Error('Original declaration inventory differs from its configured physical owner.');
    }
    await verifyAssemblerModuleCapability(asm, artifact);
    assertCallerData();
    verifyDeclarations();
    if (JSON.stringify(callerArtifact) !== artifactJson) throw new Error('Original declaration source changed during installation.');
  };
  await verifyCurrent();
  const first = artifact.modules[0];
  if (first === undefined) throw new Error('File retirement requires an original entry module.');
  const module = await importOriginalModule(first.path);
  const definition = data(module, 'appDefinition');
  if (data(definition, 'id') !== scope.app) throw new Error('File retirement declared app differs from the owner.');
  const originalContracts = declarationWire(data(definition, 'contracts')) as Readonly<Record<string, WireValue>>;
  const valueDefaults = originalDefaults(originalContracts);
  const captures: ModuleCapture[] = [];
  captureModuleInvocations(artifact, first.path, definition, captures);
  verifyDeclarations = () => verifyCapturedDeclarations(originalContracts, definition, captures);
  for (const emitted of artifact.modules.slice(1)) {
    const imported = await importOriginalModule(emitted.path);
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
    captureModuleInvocations(artifact, emitted.path, data(imported, 'appDefinition'), captures);
    await verifyCurrent();
  }
  await verifyCurrent();
  assertCallerArtifact();
  const loaded = await loadCanonicalDescriptors(asm, artifact);
  assertCallerArtifact();
  await verifyCurrent();
  const artifactModels = artifact.models;
  if (artifactModels === undefined) throw new Error('File retirement requires complete model declarations.');
  const valueTypes = checkedNativeValueTypes(artifact, definition, loaded.valueTypes);
  const declarationGroups = new Map<string, readonly FrameworkOpaqueDeclaration[]>();
  const declarationsFor = (legacyVoidResultIds: ReadonlySet<string>): readonly FrameworkOpaqueDeclaration[] => {
    const key = JSON.stringify([...legacyVoidResultIds].sort());
    const previous = declarationGroups.get(key);
    if (previous !== undefined) return previous;
    const declarations: FrameworkOpaqueDeclaration[] = [];
    for (const callable of artifact.callables) {
      declareCallable(artifact, captures, loaded, callable, declarations, artifactModels, legacyVoidResultIds);
    }
    declareModuleEvents(artifact, captures, loaded, declarations);
    declareStandardCompletions(artifact, captures, loaded, declarations);
    const prepared = immutable(declarations);
    declarationGroups.set(key, prepared);
    return prepared;
  };
  return Object.freeze({ artifact, digest, definition, originalContracts, valueDefaults, loaded, artifactModels, valueTypes, verifyCurrent, declarationsFor });
}

async function installNativeFileInventoryForOwner(input: NativeFileInventoryInput,
  prepared: Awaited<ReturnType<typeof prepareNativeFileInventory>>) {
  const { store, now } = input;
  const scope = immutable(input.scope), authority = immutable(input.authority);
  const { artifact, digest, definition, originalContracts, valueDefaults, loaded, artifactModels, valueTypes, verifyCurrent } = prepared;
  await verifyCurrent();
  if (data(definition, 'id') !== scope.app) throw new Error('File retirement declared app differs from the owner.');
  data(data(definition, 'packages'), scope.ownerPackage);
  const inventoryIdentity = Object.freeze({ owner: scope.ownerPackage, snapshotId: `native-file:${digest}`, digest });
  const installed = await store.readFileReferenceInventory(scope.ownerPackage);
  await verifyCurrent();
  const legacyVoidResultIds = new Set(installed?.inventory.opaqueDeclarationSets?.flatMap(set =>
    set.declarations.filter(declaration => declaration.profile.kind === 'void' &&
      Object.hasOwn(declaration.profile.canonical, 'disclosure') &&
      Object.hasOwn(declaration.profile.artifact, 'disclosure')).map(declaration => declaration.id)) ?? []);
  const declarations = prepared.declarationsFor(legacyVoidResultIds);
  // App-wide scope (the key prefixes no model) covers every model in this
  // one inventory; package scopes keep their owning-package subdivision.
  const appWide = !ownerPrefixesModels(artifactModels, scope.ownerPackage);
  const ownedModels = <T extends { readonly name: string }>(models: readonly T[]): readonly T[] =>
    appWide ? models : models.filter(model => model.name.split('.')[0] === scope.ownerPackage);
  const baseInventory = immutable({ ...inventoryIdentity,
    // Register each domain model under its canonical owning package. The
    // declaration set below retains the complete imported schema closure.
    canonicalModels: ownedModels(loaded.models),
    artifactModels: ownedModels(artifactModels), valueTypes,
    frameworkModels: [...STATE_FILE_REFERENCE_PRODUCER.models, ...WORK_FILE_REFERENCE_PRODUCER.models] });
  const expectedRevision = await store.readRevision();
  await verifyCurrent();
  const originalSnapshot = await store.readInstalledSnapshot(scope.ownerPackage);
  await verifyCurrent();
  const snapshot = installed?.snapshot ?? originalSnapshot ?? { ...inventoryIdentity,
    installedRevision: (expectedRevision + 1) as Revision, installedAt: now() };
  const declarationSet: FrameworkOpaqueDeclarationSet = immutable({ id: `${inventoryIdentity.snapshotId}:declarations`,
    inventory: inventoryIdentity, snapshot, sources: artifact.sources, canonicalModels: loaded.models,
    artifactModels, valueTypes, originalContracts, valueDefaults, declarations });
  if (installed !== null && input.retainUnchangedDeclarations === true) {
    const originals = installed.inventory.opaqueDeclarationSets;
    const storageDeclarations = (set: FrameworkOpaqueDeclarationSet) => ({
      canonicalModels: set.canonicalModels, artifactModels: set.artifactModels, valueTypes: set.valueTypes,
      originalContracts: set.originalContracts, valueDefaults: set.valueDefaults,
      declarations: set.declarations.map(({ id, profile }) => ({ id, profile })),
    });
    if (originals?.length !== 1 || !equal(installed.inventory.frameworkModels, baseInventory.frameworkModels) ||
        !equal(storageDeclarations(originals[0]!), storageDeclarations(declarationSet))) {
      throw new Error('Soda installed storage declarations changed; migration/restore must be explicit');
    }
    // Retained rows reference their original source declarations and snapshot.
    // Replacing these facts would be a migration, even if only the title changed.
    await store.installFileReferenceInventory({ expectedRevision, authority,
      inventory: installed.inventory, snapshot: installed.snapshot });
    await verifyCurrent();
    return Object.freeze({ inventory: installed.inventory, verifyCurrent });
  }
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
