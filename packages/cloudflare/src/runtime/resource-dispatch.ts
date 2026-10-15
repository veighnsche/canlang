/** Typed resource sends use the existing atomic Work outbox and fenced dispatcher. */
import type { BoundCapabilityRequest, CanValue, OutboxIntent, StoragePort, WireValue } from '@canlang/contracts';
import { encodeValue, normalizeSchema, validateOperationInput, type NormalizedSchema, type SchemaDescriptor } from '@canlang/values';
import { WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS, createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { assembleDispatchCommands } from '../worker/assembly.js';
import { nativeValueReferenceEncoder } from './native-value-schema.js';
import {
  createWorkerDispatchRegistry, createWorkerDispatchJoinPort, loadDispatchSystemProducers,
  withDispatchJoinPort, driveDispatchIntent, driveDispatchIntentWithPreclaim, runRecoverySweep,
  type DispatchProviderOutcome, type DispatchReconcileEvidence,
  type DriveDispatchIntentOpts, type DriveDispatchFenceInput, type RecoverySweepOpts,
} from './invoke.js';

/** Structural view of the compiler-owned runtimeBindings inventory. */
export type ResourceSendBinding = {
  readonly owner: string; readonly name: string; readonly binding: string;
} & ({ readonly kind: 'queue'; readonly type: string; readonly handlers: readonly string[] }
  | { readonly kind: 'analytics-engine'; readonly schema: readonly { readonly name: string; readonly type: string }[] });

const own = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor !== undefined && !('value' in descriptor)) throw new Error('Resource metadata requires own data properties.');
  return descriptor?.value;
};
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const closed = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => record(value) &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function selectedBinding(definition: unknown, binding: string): ResourceSendBinding | null {
  const declarations = own(definition, 'runtimeBindings');
  if (declarations === undefined) return null;
  if (!Array.isArray(declarations)) throw new Error('Runtime bindings must be the compiler declaration array.');
  const selected = declarations.filter(declaration => own(declaration, 'binding') === binding);
  if (selected.length === 0) return null;
  if (selected.length !== 1) throw new Error('Resource binding must select one owning declaration.');
  const declaration: unknown = selected[0], kind = own(declaration, 'kind');
  if (kind !== 'queue' && kind !== 'analytics-engine') return null;
  const owner = own(declaration, 'owner'), name = own(declaration, 'name');
  if (typeof owner !== 'string' || owner === '' || typeof name !== 'string' || name === '' || binding !== `${owner}.${name}`) {
    throw new Error('Resource send lost its canonical owner and binding.');
  }
  if (kind === 'queue') {
    const type = own(declaration, 'type'), handlers = own(declaration, 'handlers');
    if (typeof type !== 'string' || type === '' || !Array.isArray(handlers) || handlers.some(handler => typeof handler !== 'string' || handler === '')) {
      throw new Error('Queue requires its checked payload type and handler inventory.');
    }
    return { owner, name, binding, kind, type, handlers: [...handlers] as string[] };
  }
  const fields = own(declaration, 'schema');
  if (!Array.isArray(fields)) throw new Error('Analytics requires its checked field schema.');
  const names = new Set<string>();
  const schema = fields.map(field => {
    const name = own(field, 'name'), type = own(field, 'type');
    if (typeof name !== 'string' || name === '' || names.has(name) || typeof type !== 'string' || type === '') {
      throw new Error('Analytics requires unique typed fields.');
    }
    names.add(name); return { name, type };
  });
  return { owner, name, binding, kind, schema };
}

function resourceOperation(binding: ResourceSendBinding): string {
  return `${binding.binding}.${binding.kind === 'queue' ? 'publish' : 'write'}`;
}

/** Match only a checked source-owned sink, including guarded-send admission. */
export function isResourceSendTarget(definition: unknown, bindingKey: string, source: string): boolean {
  const binding = selectedBinding(definition, bindingKey);
  return binding !== null && source === resourceOperation(binding);
}

/** The checked target owner is distinct from an invoking source package. */
export function resourceSendOwner(definition: unknown, bindingKey: string, source: string): string | undefined {
  const binding = selectedBinding(definition, bindingKey);
  return binding !== null && source === resourceOperation(binding) ? binding.owner : undefined;
}

function requestSchema(binding: ResourceSendBinding, schema?: NormalizedSchema): NormalizedSchema {
  const inputs = binding.kind === 'queue' ? { value: { type: binding.type } }
    : Object.fromEntries(binding.schema.map(field => [field.name, { type: field.type }]));
  const operation = normalizeSchema({ operations: { [resourceOperation(binding)]: { inputs } } } as SchemaDescriptor);
  return { ...operation, ...schema, operations: operation.operations };
}

/** Pure source-stage validation/encoding. This function never commits or calls a resource. */
export function resolveResourceSend(definition: unknown, source: string, payload: unknown, bindingKey: string,
  options: { readonly valueSchema?: NormalizedSchema } = {}): BoundCapabilityRequest | null {
  const binding = selectedBinding(definition, bindingKey);
  if (binding === null) return null;
  if (source !== resourceOperation(binding)) throw new Error('Resource send does not match its checked owning operation.');
  const schema = requestSchema(binding, options.valueSchema);
  const native = payload;
  if (!record(native)) throw new Error('Resource send requires its typed payload.');
  const inputs = schema.operations[source]?.inputs;
  if (inputs === undefined) throw new Error('Resource operation inputs are unavailable.');
  const encoded: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(native)) {
    const input = inputs[key];
    encoded[key] = input === undefined ? native[key] : encodeValue(input.typeId, native[key] as CanValue, nativeValueReferenceEncoder(input.typeId, schema, native[key]), schema);
  }
  const checked = validateOperationInput(schema, source, encoded);
  const args: Record<string, WireValue> = Object.create(null);
  for (const [key, value] of Object.entries(checked)) args[key] = encodeValue(inputs[key]!.typeId, value, undefined, schema);
  return { binding: bindingKey, from: bindingKey, arguments: args };
}

export interface ResourceEvent {
  /** Original stable Work intent identity; retries never mint a second event. */
  readonly eventId: string;
  readonly source: string;
  readonly arguments: Readonly<Record<string, WireValue>>;
}
export interface InstalledResourceTransport {
  readonly kind: ResourceSendBinding['kind'];
  /** Queue publish or a real observable analytics write; a no-op is not an installation. */
  deliver(event: ResourceEvent): Promise<void>;
  /** Absence/ambiguity cannot be upgraded to evidence of successful delivery. */
  reconcile?(eventId: string): Promise<DispatchReconcileEvidence | null>;
}

/** Only an installed transport can prove a failed attempt never reached its resource. */
export class ResourceDeliveryRejected extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); this.name = 'ResourceDeliveryRejected'; }
}

export function createResourceAdapter(options: {
  readonly appDefinition: unknown;
  readonly valueSchema?: NormalizedSchema;
  readonly transports: ReadonlyMap<string, InstalledResourceTransport>;
}) {
  const resolve = (intent: OutboxIntent): { transport: InstalledResourceTransport; event: ResourceEvent } | null => {
    try {
      if (!closed(intent.arguments, ['binding', 'from', 'arguments']) || typeof intent.arguments.binding !== 'string' ||
          intent.arguments.from !== intent.arguments.binding || typeof intent.intentId !== 'string' || intent.intentId === '') return null;
      const binding = selectedBinding(options.appDefinition, intent.arguments.binding);
      const transport = options.transports.get(intent.arguments.binding);
      if (binding === null || transport?.kind !== binding.kind || intent.target !== resourceOperation(binding) || !record(intent.arguments.arguments)) return null;
      const schema = requestSchema(binding, options.valueSchema);
      validateOperationInput(schema, intent.target, intent.arguments.arguments);
      return { transport, event: Object.freeze({ eventId: intent.intentId, source: intent.target,
        arguments: structuredClone(intent.arguments.arguments) as Record<string, WireValue> }) };
    } catch { return null; }
  };
  return {
    available: (intent: OutboxIntent): boolean => resolve(intent) !== null,
    async callProvider(intent: OutboxIntent): Promise<DispatchProviderOutcome> {
      const selected = resolve(intent);
      if (selected === null) return { kind: 'uncertain' };
      try {
        await selected.transport.deliver(selected.event);
        return { kind: 'delivered', result: { eventId: intent.intentId } };
      } catch (error) {
        if (error instanceof ResourceDeliveryRejected) return { kind: 'failed', cause: {
          kind: error.retryable ? 'transient' : 'permanent', code: 'resource_rejected', message: error.message,
        } };
        return { kind: 'uncertain' };
      }
    },
    async reconcile(intent: OutboxIntent): Promise<DispatchReconcileEvidence | null> {
      const selected = resolve(intent);
      if (selected === null || selected.transport.reconcile === undefined) return null;
      try { return await selected.transport.reconcile(intent.intentId); } catch { return null; }
    },
  };
}

export type ResourceDriveOptions = Omit<DriveDispatchIntentOpts, 'registry' | 'store' | 'intent' | 'callProvider' | 'fence'> & {
  readonly intentId: string; readonly fence: DriveDispatchFenceInput;
};
export type ResourceRecoveryOptions = Omit<RecoverySweepOpts, 'registry' | 'store' | 'joinPort' | 'readEvidence' | 'stageReconciledReceipt' | 'revalidateReconciledReceipt'> & {
  readonly revalidateAuthority: () => boolean | Promise<boolean>;
};

/** Resources share Work's original commit marker, claim, record, acknowledgement and recovery. */
export async function createResourceDispatcher(options: {
  readonly store: StoragePort; readonly adapter: ReturnType<typeof createResourceAdapter>;
}) {
  const pending = new Map<string, OutboxIntent>();
  const refresh = async () => { pending.clear(); for (const intent of await options.store.outboxPending()) {
    if (options.adapter.available(intent)) pending.set(intent.intentId, intent);
  } };
  const claim = createWorkDispatchClaimCommand((id, target) => {
    const intent = pending.get(id); return intent !== undefined && intent.target === target && options.adapter.available(intent);
  });
  const producers = await loadDispatchSystemProducers();
  const commands = assembleDispatchCommands({ l3Commands: producers.l3Commands,
    workCommands: WORK_SYSTEM_COMMANDS.map(command => command.name === claim.name ? claim : command), stageCommands: WORK_DISPATCH_STAGE_COMMANDS });
  const registry = await createWorkerDispatchRegistry(commands);
  const joinPort = await createWorkerDispatchJoinPort(options.store);
  const store = withDispatchJoinPort(options.store, joinPort);
  return {
    async drive(input: ResourceDriveOptions) {
      await refresh();
      const intent = pending.get(input.intentId);
      if (intent === undefined) return { status: 'not-pending' as const, intentId: input.intentId };
      if (!options.adapter.available(intent)) return { status: 'unavailable' as const, intentId: input.intentId, target: intent.target };
      const drive = { ...input, store, intent, callProvider: (selected: OutboxIntent) => options.adapter.callProvider(selected) };
      return input.fence.asyncGuard !== undefined && intent.dispatchGuard != null
        ? driveDispatchIntentWithPreclaim(drive, (guard, allocator) => {
          const guarded = createWorkDispatchClaimCommand((id, target) => id === intent.intentId && target === intent.target && options.adapter.available(intent), guard, allocator);
          return producers.createSystemRegistry(commands.map(command => command.name === claim.name ? guarded : command));
        }) : driveDispatchIntent({ ...drive, registry });
    },
    async recover(input: ResourceRecoveryOptions) {
      if (await input.revalidateAuthority() !== true) throw new Error('Resource recovery authority is unavailable.');
      await refresh();
      if (pending.size === 0) return;
      const evidence = new Map<string, DispatchReconcileEvidence | null>();
      for (const intent of pending.values()) evidence.set(intent.intentId, await options.adapter.reconcile(intent));
      // This consumer owns resource intents only. A shared owner may also have mail/provider work.
      const ids = [...pending.keys()].slice(0, input.limit);
      const selected: StoragePort = { ...store, query: spec => spec.model !== 'work.dispatch' ? store.query(spec)
        : store.query({ ...spec, where: { op: 'and', args: [
          ...(spec.where === undefined ? [] : [spec.where]),
          { op: 'or', args: ids.map(id => ({ op: 'eq' as const, field: 'id', value: id })) },
        ] } }) };
      return runRecoverySweep({ ...input, registry, store: selected, joinPort, readEvidence: id => evidence.get(id) ?? null,
        revalidateReconciledReceipt: async () => { if (await input.revalidateAuthority() !== true) throw new Error('Resource recovery authority was revoked.'); } });
    },
  };
}
