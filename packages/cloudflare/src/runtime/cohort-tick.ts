import type { CompileArtifact, ModelName, RecordId, WorkScope } from '@canlang/contracts';
import type { IdentityStore } from '@canlang/identity';
import type { AssembledModules } from './modules.js';
import type { CohortTickBinding, TeamOwnerStorageBoundary } from '../worker/assembly.js';
import { WORK_SCHEDULE_MODEL, readScheduleRow } from '@canlang/work/kernel/tables';
import { handlerOccurrencePendingQuery, readHandlerOccurrenceRow } from '@canlang/work/kernel/handler-occurrence';
import { FANOUT_OWNER_SCAN_MODEL, fanoutOwnerScanRowId, fanoutOwnerIntentQuery } from '@canlang/state/fanout/navigation';
import { admitRetainedFanoutChunk } from '@canlang/state/fanout/membership';
import { mintOperationId } from '@canlang/ui';
import {
  createCanonicalDueCohortBody, invokeDueSourceRoutingCanonical,
  invokeRetainedHandlerOccurrenceCanonical, loadFanoutStateProducers,
  maintainFanoutNavigationCanonical, runRetainedFanoutSchedulerTurn, T34F7_FANOUT_CHECKPOINT_MODEL,
} from './invoke.js';

/** One selected team, one bounded slice; no owner discovery or global store. */
export async function createBoundCohortTick(input: {
  readonly artifact: CompileArtifact;
  readonly asm: AssembledModules;
  readonly identities: IdentityStore;
  readonly ownerStorage: TeamOwnerStorageBoundary;
  readonly scope: WorkScope;
  readonly now: () => number;
}): Promise<CohortTickBinding> {
  const { artifact, asm, identities, ownerStorage, now: clock } = input;
  const scope = Object.freeze({ ...input.scope });
  if (scope.app !== ownerStorage.app) throw new Error('Cohort tick app disagrees with its owner boundary.');
  const entry: unknown = await import(asm.entryUrl);
  const definition = (entry as { appDefinition?: { id?: string; packages?: Record<string, unknown> } }).appDefinition;
  if (definition?.id !== scope.app || definition.packages === undefined ||
      !Object.hasOwn(definition.packages, scope.ownerPackage)) {
    throw new Error('Cohort tick requires its exact declared app and owner package.');
  }
  return Object.freeze({ version: 1 as const, async tick() {
    const now = clock();
    // This boundary performs actual current Identity resolution before any State read.
    const { store } = await ownerStorage.forTrustedScope(scope, now);
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
      let handler: string | undefined;
      for (const callable of artifact.callables) {
        if (callable.kind !== 'handler') continue;
        const module: unknown = await import(asm.moduleUrls[callable.module]!);
        const operation = (module as { appDefinition?: { operations?: Record<string, { event?: string }> } })
          .appDefinition?.operations?.[callable.id];
        if (operation?.event === source.event) { handler = callable.id; break; }
      }
      if (handler === undefined) throw new Error('Cohort tick due event has no declared handler.');
      outputs.push(await invokeDueSourceRoutingCanonical({ artifact, asm, app: scope.app, handler,
        due: { key: source.key, at: source.at, event: source.event, occurrenceId: source.occurrenceId, scope },
        store, identities, now: () => now, cohortBounds: { pageLimit: 100, chunkSize: 100 } }));
    }
    const routes = await store.query(handlerOccurrencePendingQuery(scope, { cursor: null, limit: 1 }));
    for (const row of routes) {
      const route = readHandlerOccurrenceRow(row);
      outputs.push(await invokeRetainedHandlerOccurrenceCanonical({ artifact, asm, app: scope.app,
        selector: { sourceOccurrence: route.sourceOccurrence, handler: route.handler, event: route.event, scope },
        store, identities, now: () => now }));
    }
    const scan = await store.load(FANOUT_OWNER_SCAN_MODEL as ModelName, fanoutOwnerScanRowId(scope.owner) as RecordId);
    const intents = await store.query(fanoutOwnerIntentQuery({ row: scan, owner: scope.owner, limit: 1 }));
    if (intents.length === 0) {
      outputs.push(await maintainFanoutNavigationCanonical({ boundary: ownerStorage, scope, now }));
      return outputs;
    }
    const intentRow = intents[0]!;
    const producers = await loadFanoutStateProducers();
    const intent = producers.tables.readFanoutIntentRow(intentRow);
    const sourceRow = await store.load(WORK_SCHEDULE_MODEL, intent.sourceOccurrence as RecordId);
    if (sourceRow === null) throw new Error('Cohort tick retained intent lost its authoritative source.');
    const source = readScheduleRow(sourceRow);
    if (source.scopeApp !== scope.app || source.scopeOwner !== scope.owner || source.scopeOwnerPackage !== scope.ownerPackage) {
      throw new Error('Cohort tick retained source disagrees with its selected owner.');
    }
    const body = await createCanonicalDueCohortBody({ artifact, asm, app: scope.app, handler: intent.handler,
      due: { key: source.key, at: source.at, event: source.event, occurrenceId: source.occurrenceId, scope },
      store, identities, now: () => now });
    const checkpoint = await store.load(T34F7_FANOUT_CHECKPOINT_MODEL, intentRow.id);
    if (checkpoint === null) throw new Error('Cohort tick retained intent lost its checkpoint.');
    const admissionStore = { ...store, async commit(batch: Parameters<typeof store.commit>[0]) {
      await ownerStorage.forTrustedScope(scope, now);
      return store.commit(batch);
    } };
    const admission = await admitRetainedFanoutChunk({ store: admissionStore, intentRow, checkpointRow: checkpoint,
      chunkSize: body.bounds.chunkSize, expectedRevision: await store.readRevision(),
      meta: { actor: body.trustedSource, nowMs: now } });
    if (!admission.ok) return [...outputs, admission];
    outputs.push(await runRetainedFanoutSchedulerTurn({ store, owner: scope.owner, retainedIntent: intentRow,
      sourceOwner: { boundary: ownerStorage, scope },
      fanoutId: body.fanoutId, advanceOwnerScan: true,
      bounds: { pageLimit: body.bounds.pageLimit, maxDrives: 1 }, policy: { maxAttempts: 3, horizonMs: 60_000 },
      meta: { actor: body.trustedSource, nowMs: now }, maxClaimAgeMs: 60_000,
      cohort: { model: body.cohort.model, ...(body.cohort.kind === 'anchored-collection' ? { anchor: body.cohort.parent } : {}) },
      guard: { predicate: null, frozenInputs: null }, evaluateGuard: () => true,
      readSnapshot: (_child, row) => row,
      fenceFor: () => ({ owner: scope.owner, revalidateAuthority: async () =>
        (await identities.findTeamById(body.identity.team!.team_id)) !== null }),
      body: body.body, producers,
      invoke: { registry: body.registry, memberships: identities, clock: { nowMs: () => now }, identity: body.identity,
        app: scope.app, source: 'schedule', childOperation: intent.handler, refInput: body.refInput,
        inputs: body.inputs, kind: 'trusted', trustedSource: body.trustedSource,
        operationIdFor: () => mintOperationId(() => now) } }));
    return outputs;
  } });
}
