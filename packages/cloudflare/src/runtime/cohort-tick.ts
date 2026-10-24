import type { CompileArtifact, ModelName, RecordId, WorkScope } from '@canlang/contracts';
import type { IdentityStore } from '@canlang/identity';
import type { AssembledModules } from './modules.js';
import type { CanonicalFileBinding } from './file-staging.js';
import type { CohortTickBinding, TeamOwnerStorageBoundary } from '../worker/assembly.js';
import { WORK_SCHEDULE_MODEL, WORK_OCCURRENCE_MODEL, readScheduleRow, readOccurrenceRow } from '@canlang/work/kernel/tables';
import { handlerOccurrencePendingQuery, readHandlerOccurrenceRow } from '@canlang/work/kernel/handler-occurrence';
import { FANOUT_OWNER_SCAN_MODEL, fanoutOwnerScanRowId, fanoutOwnerIntentQuery } from '@canlang/state/fanout/navigation';
import { admitRetainedFanoutChunk } from '@canlang/state/fanout/membership';
import { mintOperationId } from '@canlang/ui';
import { hasAssemblerModuleCapability, importVerifiedAssemblyModule } from './assembly-verification.js';
import { validateDeploymentBase } from './env-assembly.js';
import {
  createCanonicalDueCohortBody, createCanonicalCommittedCohortBody, invokeDueSourceRoutingCanonical, loadCanonicalDescriptors,
  invokeRetainedHandlerOccurrenceCanonical, loadFanoutStateProducers,
  maintainFanoutNavigationCanonical, runRetainedFanoutSchedulerTurn, T34F7_FANOUT_CHECKPOINT_MODEL,
} from './invoke.js';
import type { FanoutStateProducers } from './invoke.js';

type TrustedOwnerStore = Awaited<ReturnType<TeamOwnerStorageBoundary['forTrustedScope']>>['store'];
type RetainedFanoutIntent = ReturnType<FanoutStateProducers['tables']['readFanoutIntentRow']>;
type RetainedCohortBody = Awaited<ReturnType<typeof createCanonicalDueCohortBody>>;

// The retained driver reads one release page and one navigation page. Frozen
// source bounds may be larger than this installation's per-turn budget; cap
// transport and admission slices without changing membership or its cutoff.
const RETAINED_CHILD_QUERY_BUDGET = 200;
const INSTALLED_SLICE_LIMIT = RETAINED_CHILD_QUERY_BUDGET / 2;

/** One selected team; every driver keeps the same trusted owner boundary. */
interface OwnerTickInput {
  readonly artifact: CompileArtifact;
  readonly asm: AssembledModules;
  readonly identities: IdentityStore;
  readonly ownerStorage: TeamOwnerStorageBoundary;
  readonly scope: WorkScope;
  readonly now: () => number;
  readonly deploymentBase?: string;
  readonly files?: CanonicalFileBinding;
}

/** One selected team, one bounded slice; no owner discovery or global store. */
export function createBoundCohortTick(input: OwnerTickInput): Promise<CohortTickBinding> {
  return createBoundOwnerTick(input);
}

/** Ordinary retained handlers do not acquire scheduled/cohort admission. */
export function createBoundRetainedHandlerTick(input: OwnerTickInput & { readonly event: string }): Promise<CohortTickBinding> {
  if (typeof input.event !== 'string' || input.event === '') throw new Error('Retained handler tick requires its selected event.');
  return createBoundOwnerTick(input, input.event);
}

async function createBoundOwnerTick(input: OwnerTickInput, retainedEvent?: string): Promise<CohortTickBinding> {
  const { artifact, asm, identities, ownerStorage, files, now: clock } = input;
  const scope = Object.freeze({ ...input.scope });
  const deploymentBase = input.deploymentBase === undefined ? undefined : validateDeploymentBase(input.deploymentBase);
  if (scope.app !== ownerStorage.app) throw new Error('Cohort tick app disagrees with its owner boundary.');
  await loadCanonicalDescriptors(asm, artifact);
  const verified = hasAssemblerModuleCapability(asm);
  const importSource = async (path: string): Promise<unknown> => verified
    ? importVerifiedAssemblyModule(asm, path, artifact) : import(asm.moduleUrls[path]!);
  const entry: unknown = verified ? await importSource(artifact.modules[0]!.path) : await import(asm.entryUrl);
  const definition = (entry as { appDefinition?: { id?: string; packages?: Record<string, unknown> } }).appDefinition;
  if (definition?.id !== scope.app || definition.packages === undefined ||
      !Object.hasOwn(definition.packages, scope.ownerPackage)) {
    throw new Error('Cohort tick requires its exact declared app and owner package.');
  }
  const findDueHandler = async (event: string): Promise<string> => {
    for (const callable of artifact.callables) {
      if (callable.kind !== 'handler') continue;
      const module: unknown = await importSource(callable.module);
      const operation = (module as { appDefinition?: { operations?: Record<string, { event?: string }> } })
        .appDefinition?.operations?.[callable.id];
      if (operation?.event === event) return callable.id;
    }
    throw new Error('Cohort tick due event has no declared handler.');
  };

  const drainDueSchedules = async (store: TrustedOwnerStore, now: number): Promise<unknown[]> => {
    const outputs: unknown[] = [];
    const schedules = await store.query({ model: WORK_SCHEDULE_MODEL, authority: 'owner',
      where: { op: 'and', args: [
        { op: 'eq', field: 'scopeApp', value: scope.app },
        { op: 'eq', field: 'scopeOwner', value: scope.owner },
        { op: 'eq', field: 'scopeOwnerPackage', value: scope.ownerPackage },
        { op: 'eq', field: 'state', value: 'pending' },
        { op: 'lte', field: 'at', value: now },
      ] }, order: [{ field: 'at', direction: 'asc' }, { field: 'id', direction: 'asc' }], limit: 1 });
    for (const row of schedules) {
      const source = readScheduleRow(row);
      const handler = await findDueHandler(source.event);
      outputs.push(await invokeDueSourceRoutingCanonical({ artifact, asm, app: scope.app, handler,
        due: { key: source.key, at: source.at, event: source.event, occurrenceId: source.occurrenceId, scope,
          ...(source.filePayloadOrigin === undefined ? {} : { filePayloadOrigin: source.filePayloadOrigin }) },
        store, identities, now: () => now, ...(deploymentBase === undefined ? {} : { deploymentBase }),
        ...(files === undefined ? {} : { files }),
        cohortBounds: { pageLimit: INSTALLED_SLICE_LIMIT, chunkSize: INSTALLED_SLICE_LIMIT } }));
    }
    return outputs;
  };

  const drainRetainedOccurrences = async (store: TrustedOwnerStore, now: number): Promise<unknown[]> => {
    const outputs: unknown[] = [];
    const query = handlerOccurrencePendingQuery(scope, { cursor: null, limit: 1 });
    const routes = await store.query(retainedEvent === undefined ? query : { ...query,
      where: { op: 'and', args: [...query.where === undefined ? [] : [query.where],
        { op: 'eq', field: 'event', value: retainedEvent }] } });
    for (const row of routes) {
      const route = readHandlerOccurrenceRow(row);
      outputs.push(await invokeRetainedHandlerOccurrenceCanonical({ artifact, asm, app: scope.app,
        ownerStorage, selector: { sourceOccurrence: route.sourceOccurrence, handler: route.handler, event: route.event, scope,
          ...(route.filePayloadOrigin === undefined ? {} : { filePayloadOrigin: route.filePayloadOrigin }) },
        store, identities, now: () => now, ...(deploymentBase === undefined ? {} : { deploymentBase }),
        ...(files === undefined ? {} : { files }) }));
    }
    return outputs;
  };

  const loadRetainedCohortBody = async (
    store: TrustedOwnerStore, intent: RetainedFanoutIntent, now: number,
  ): Promise<RetainedCohortBody> => {
    const sourceRow = await store.load(WORK_SCHEDULE_MODEL, intent.sourceOccurrence as RecordId);
    if (sourceRow !== null) {
      const source = readScheduleRow(sourceRow);
      if (source.scopeApp !== scope.app || source.scopeOwner !== scope.owner || source.scopeOwnerPackage !== scope.ownerPackage) {
        throw new Error('Cohort tick retained source disagrees with its selected owner.');
      }
      return createCanonicalDueCohortBody({ artifact, asm, app: scope.app, handler: intent.handler,
        due: { key: source.key, at: source.at, event: source.event, occurrenceId: source.occurrenceId, scope,
          ...(source.filePayloadOrigin === undefined ? {} : { filePayloadOrigin: source.filePayloadOrigin }) },
        store, identities, now: () => now, ...(deploymentBase === undefined ? {} : { deploymentBase }),
        ...(files === undefined ? {} : { files }) });
    }
    const row = await store.load(WORK_OCCURRENCE_MODEL, intent.sourceOccurrence as RecordId);
    if (row === null) throw new Error('Cohort tick retained intent lost its authoritative source.');
    const receipt = readOccurrenceRow(row);
    const result = receipt.result as { kind?: unknown; event?: unknown } | null;
    if (receipt.status !== 'completed' ||
        result?.kind !== 'committed-model-source' && result?.kind !== 'standard-completion-source' && result?.kind !== 'declared-event-source' || typeof result?.event !== 'string') {
      throw new Error('Cohort tick retained intent lacks a checked source receipt.');
    }
    return createCanonicalCommittedCohortBody({ artifact, asm, app: scope.app, handler: intent.handler,
      source: { occurrenceId: intent.sourceOccurrence, event: result.event, scope }, store, identities, now: () => now,
      ...(deploymentBase === undefined ? {} : { deploymentBase }), ...(files === undefined ? {} : { files }) });
  };

  return Object.freeze({ version: 1 as const, async tick() {
    const now = clock();
    // This boundary performs actual current Identity resolution before any State read.
    const { store } = await ownerStorage.forTrustedScope(scope, now);
    const revalidateOwnerStorage = async () => {
      try {
        const current = await ownerStorage.forTrustedScope(scope, now);
        if (current.store !== store) throw new Error('The retained owner storage binding changed.');
      } catch (cause) {
        // Lost physical custody is not a record-level refusal: leave a committed
        // claim for recovery rather than writing its refusal through the old port.
        throw new Error('Cohort tick lost its current owner storage binding.', { cause });
      }
      return true;
    };
    if (retainedEvent !== undefined) return drainRetainedOccurrences(store, now);
    const outputs: unknown[] = [
      ...await drainDueSchedules(store, now),
      ...await drainRetainedOccurrences(store, now),
    ];
    const scan = await store.load(FANOUT_OWNER_SCAN_MODEL as ModelName, fanoutOwnerScanRowId(scope.owner) as RecordId);
    const intents = await store.query(fanoutOwnerIntentQuery({ row: scan, owner: scope.owner, limit: 1 }));
    if (intents.length === 0) {
      outputs.push(await maintainFanoutNavigationCanonical({ boundary: ownerStorage, scope, now }));
      return outputs;
    }
    const intentRow = intents[0]!;
    const producers = await loadFanoutStateProducers();
    const intent = producers.tables.readFanoutIntentRow(intentRow);
    const body = await loadRetainedCohortBody(store, intent, now);
    const checkpoint = await store.load(T34F7_FANOUT_CHECKPOINT_MODEL, intentRow.id);
    if (checkpoint === null) throw new Error('Cohort tick retained intent lost its checkpoint.');
    const admissionStore = { ...store, async commit(batch: Parameters<typeof store.commit>[0]) {
      await revalidateOwnerStorage();
      await body.verifySource(now);
      await revalidateOwnerStorage();
      return store.commit(batch);
    } };
    const admission = await admitRetainedFanoutChunk({ store: admissionStore, intentRow, checkpointRow: checkpoint,
      chunkSize: Math.min(body.bounds.chunkSize, INSTALLED_SLICE_LIMIT), expectedRevision: await store.readRevision(),
      meta: { actor: body.trustedSource, nowMs: now } });
    if (!admission.ok) return [...outputs, admission];
    outputs.push(await runRetainedFanoutSchedulerTurn({ store, owner: scope.owner, retainedIntent: intentRow,
      sourceOwner: { boundary: ownerStorage, scope, sourceAssembly: { asm, artifact, identities } },
      fanoutId: body.fanoutId, advanceOwnerScan: true,
      bounds: { pageLimit: Math.min(body.bounds.pageLimit, INSTALLED_SLICE_LIMIT), maxDrives: 1 },
      policy: { maxAttempts: 3, horizonMs: 60_000 },
      meta: { actor: body.trustedSource, nowMs: now }, maxClaimAgeMs: 60_000,
      cohort: { model: body.cohort.model, ...(body.cohort.kind === 'anchored-collection' ? { anchor: body.cohort.parent } : {}) },
      guard: { predicate: null, frozenInputs: null }, evaluateGuard: () => true,
      readSnapshot: (_child, row) => row,
      fenceFor: () => ({ owner: scope.owner, revalidateAuthority: revalidateOwnerStorage }),
      body: body.body, producers,
      invoke: { registry: body.registry, memberships: identities, clock: { nowMs: () => now }, identity: body.identity,
        app: scope.app, source: 'schedule', childOperation: intent.handler, refInput: body.refInput,
        inputs: body.inputs, kind: 'trusted', trustedSource: body.trustedSource,
        operationIdFor: () => mintOperationId(() => now) } }));
    return outputs;
  } });
}
