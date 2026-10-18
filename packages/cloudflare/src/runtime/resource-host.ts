/** Installed resource delivery over each actual owner store, never a broker-selected store. */
import type { CompileArtifact, StoragePort, WorkScope } from '@canlang/contracts';
import type { IdentityStore } from '@canlang/identity';
import { resolveIdentity } from '@canlang/identity';
import { normalizeSchema, type SchemaDescriptor } from '@canlang/values';
import { attemptDispatch } from '@canlang/work/dispatch';
import { classifyFailure } from '@canlang/work/receipt';
import { planRecoveryScan } from '@canlang/work/recovery';
import { handlerOccurrencePendingQuery } from '@canlang/work/kernel/handler-occurrence';
import type { AssembledModules } from './modules.js';
import { bindNativeEmailDispatchGuards, type CanonicalRetainedHandlerOccurrenceOpts, type FenceAttemptDispatchFn } from './invoke.js';
import { createResourceAdapter, createResourceDispatcher, ResourceDeliveryRejected,
  type InstalledResourceTransport } from './resource-dispatch.js';
import type { CanonicalFileBinding } from './file-staging.js';
import { createQueueRuntime } from './queue-runtime.js';

export interface ResourceMessage {
  readonly body: unknown;
  ack(): void;
  retry(): void;
}
export interface ResourceBatch { readonly queue: string; readonly messages: readonly ResourceMessage[] }
export interface ResourceHostOptions {
  readonly artifact: CompileArtifact;
  readonly asm: AssembledModules;
  readonly env: Record<string, unknown>;
  readonly store: StoragePort;
  readonly identities: IdentityStore;
  readonly scope: WorkScope;
  readonly now?: () => number;
  readonly files?: CanonicalFileBinding;
  /** Additional private physical actor locator; never authentication. */
  readonly locator?: Readonly<Record<string, string>>;
  readonly createRecordAllocator?: CanonicalRetainedHandlerOccurrenceOpts['createRecordAllocator'];
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function assertHostDefinition(options: ResourceHostOptions, definition: unknown): Record<string, unknown> {
  if (!object(definition) || definition['id'] !== options.scope.app ||
      JSON.stringify(definition['runtimeBindings']) !== JSON.stringify(options.artifact.runtimeBindings)) {
    throw new Error('Resource host requires its original selected app and compiler binding inventory.');
  }
  const owners = definition['runtimeBindingOwners'];
  if (!Array.isArray(owners) || owners.some(owner => typeof owner !== 'string')) {
    if ((options.artifact.runtimeBindings?.length ?? 0) !== 0) throw new Error('Resource host requires its selected source owner closure.');
  }
  return definition;
}

export async function createResourceHost(options: ResourceHostOptions) {
  const { artifact, asm, env, store, identities } = options;
  const module: unknown = await import(asm.entryUrl);
  const definition = assertHostDefinition(options, object(module) ? module['appDefinition'] : undefined);
  const owners = definition['runtimeBindingOwners'];
  const selectedOwners = Array.isArray(owners) && owners.every(owner => typeof owner === 'string') ? owners as string[] : [];
  const bindings = (artifact.runtimeBindings ?? []).filter(binding =>
    (binding.kind === 'queue' || binding.kind === 'analytics-engine') && selectedOwners.includes(binding.owner));
  const schema = normalizeSchema({ contracts: definition['contracts'] ?? {}, enums: definition['enums'] ?? {},
    aliases: definition['aliases'] ?? {}, operations: {} } as SchemaDescriptor);
  const now = options.now ?? Date.now;
  const scopes = new Map(bindings.map(binding => [binding.owner, Object.freeze({ ...options.scope, ownerPackage: binding.owner })]));
  const queues = new Map<string, Awaited<ReturnType<typeof createQueueRuntime>>>();
  const runtimeFor = async (owner: string) => {
    let runtime = queues.get(owner);
    if (runtime === undefined) {
      runtime = await createQueueRuntime({ artifact, asm, app: options.scope.app, scope: scopes.get(owner)!, store, identities, now,
        ...(options.files === undefined ? {} : { files: options.files }),
        ...(options.locator === undefined ? {} : { rootAuthority: { binding: options.locator['binding']!, rootId: options.locator['rootId']! } }),
        ...(options.createRecordAllocator === undefined ? {} : { createRecordAllocator: options.createRecordAllocator }) });
      queues.set(owner, runtime);
    }
    return runtime;
  };
  const current = async (): Promise<boolean> => {
    try {
      const identity = await resolveIdentity(identities,
        options.scope.owner === 'app' || options.scope.owner === options.scope.app ? {} : { team_id: options.scope.owner },
        { clock: { nowMs: now } });
      return identity.actor === null && (identity.team?.team_id ??
        (options.scope.owner === 'app' ? 'app' : options.scope.app)) === options.scope.owner;
    } catch { return false; }
  };
  interface HostBinding {
    readonly kind: string;
    readonly binding: string;
    readonly owner: string;
  }
  const queueTransport = (binding: HostBinding, resource: Record<string, unknown>): InstalledResourceTransport => {
    if (typeof resource['send'] !== 'function') throw new Error(`Missing queue producer ${binding.binding}.`);
    return { kind: 'queue', async deliver(event) {
      await (await runtimeFor(binding.owner)).deliver(event, async body => {
        await (resource['send'] as (body: unknown) => Promise<void>).call(resource,
          { ...body, app: options.scope.app, owner: options.scope.owner, ownerPackage: binding.owner,
            ...(options.locator === undefined ? {} : { locator: options.locator }) });
      });
    }, async reconcile(eventId) { return (await runtimeFor(binding.owner)).reconcile(eventId); } };
  };
  const analyticsTransport = (binding: HostBinding, resource: Record<string, unknown>): InstalledResourceTransport => {
    if (typeof resource['writeDataPoint'] !== 'function') throw new Error(`Missing analytics dataset ${binding.binding}.`);
    return { kind: 'analytics-engine', async deliver(event) {
      // Retain exact Values wire (including int/decimal); numeric analytics columns are optional projections.
      const blob = JSON.stringify({ eventId: event.eventId, source: event.source, fields: event.arguments });
      if (new TextEncoder().encode(blob).byteLength > 16_384) {
        throw new ResourceDeliveryRejected('Analytics event exceeds the dataset blob quota.', false);
      }
      (resource['writeDataPoint'] as (point: unknown) => void).call(resource, { blobs: [blob], doubles: [] });
    } };
  };
  const transports = new Map<string, InstalledResourceTransport>();
  for (const binding of bindings) {
    const resource = env[binding.binding];
    if (!object(resource)) throw new Error(`Missing installed resource ${binding.binding}.`);
    if (binding.kind === 'queue') {
      transports.set(binding.binding, queueTransport(binding, resource));
    } else if (binding.kind === 'analytics-engine') {
      transports.set(binding.binding, analyticsTransport(binding, resource));
    }
  }
  const adapter = createResourceAdapter({ appDefinition: definition, valueSchema: schema, transports });
  const dispatcher = await createResourceDispatcher({ store, adapter });
  const fences = new Map<string, Awaited<ReturnType<typeof bindNativeEmailDispatchGuards>>>();
  for (const [owner, scope] of scopes) fences.set(owner, await bindNativeEmailDispatchGuards({ asm, artifact, store, identities, scope,
    revalidateAuthority: current, ...(options.files === undefined ? {} : { files: options.files }) }));
  let draining: Promise<void> | undefined;
  const driveIntent = async (intent: Awaited<ReturnType<typeof store.outboxPending>>[number]) => {
    const binding = bindings.find(binding => binding.binding === intent.arguments['binding']);
    if (binding === undefined) return null;
    const fence = intent.dispatchGuard == null ? { owner: options.scope.owner,
      attemptDispatch: attemptDispatch as FenceAttemptDispatchFn, revalidateAuthority: current }
      : fences.get(binding.owner)!(intent);
    return { intentId: intent.intentId, actor: 'can.resources', operation: 'can.resources.dispatch', nowMs: now,
      nextClaimId: () => crypto.randomUUID(), maxClaimAgeMs: 30_000,
      claimOperationId: crypto.randomUUID(), recordOperationId: crypto.randomUUID(), classifyFailure,
      evaluateGuard: () => { throw new Error('Guarded resource sends require the original native guard.'); },
      readStateSnapshot: () => null, fence };
  };
  const drainQueues = async (): Promise<void> => {
    for (const binding of bindings) if (binding.kind === 'queue') await runtimeFor(binding.owner);
    for (const runtime of queues.values()) await runtime.recover({ limit: 100 });
  };
  const driveOutbox = async (): Promise<void> => {
    if (!await current()) throw new Error('Resource owner is no longer available.');
    await dispatcher.recover({ actor: 'can.resources', operation: 'can.resources.recover', nowMs: now,
      maxClaimAgeMs: 30_000, policy: { maxAttempts: 8, horizonMs: 86_400_000 }, limit: 100,
      operationIdForStep: () => crypto.randomUUID(), planRecoveryScan, revalidateAuthority: current });
    for (const intent of (await store.outboxPending()).filter(intent => adapter.available(intent)).slice(0, 100)) {
      const driven = await driveIntent(intent);
      if (driven === null) continue;
      await dispatcher.drive(driven);
    }
    await drainQueues();
  };
  const drain = (): Promise<void> => draining ??= driveOutbox().finally(() => { draining = undefined; });
  const consumeQueueMessage = async (owner: string, message: ResourceMessage): Promise<void> => {
    const body = message.body;
    if (!object(body) || body['app'] !== options.scope.app || body['owner'] !== options.scope.owner ||
        body['ownerPackage'] !== owner || typeof body['eventId'] !== 'string' ||
        JSON.stringify(body['locator']) !== JSON.stringify(options.locator)) {
      throw new Error('Queue locator does not select this configured physical owner.');
    }
    try {
      const result = await (await runtimeFor(owner)).consume(body['eventId'] as string);
      if (result.status !== 'completed') { message.retry(); return; }
      message.ack();
    }
    catch (error) { message.retry(); throw error; }
  };
  return {
    scope: options.scope,
    locator: options.locator,
    drain,
    async pending(): Promise<boolean> {
      if ((await store.outboxPending()).some(intent => adapter.available(intent))) return true;
      for (const scope of scopes.values()) {
        if ((await store.query(handlerOccurrencePendingQuery(scope, { cursor: null, limit: 1 }))).length !== 0) return true;
      }
      return false;
    },
    async consumeEvent(bindingName: string, eventId: string) {
      const binding = bindings.find(binding => binding.kind === 'queue' && binding.binding === bindingName);
      if (binding === undefined) throw new Error('Queue event does not belong to this installed source binding.');
      return (await runtimeFor(binding.owner)).consume(eventId);
    },
    async consume(batch: ResourceBatch): Promise<void> {
      const names = env['CAN_LOCAL_QUEUE_BINDINGS'];
      const bindingName = object(names) ? names[batch.queue] : undefined;
      const binding = bindings.find(binding => binding.kind === 'queue' && binding.binding === bindingName);
      if (binding === undefined) throw new Error('Queue batch does not belong to this installed source binding.');
      for (const message of batch.messages) {
        await consumeQueueMessage(binding.owner, message);
      }
    },
  };
}
