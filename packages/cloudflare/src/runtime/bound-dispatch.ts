/** Installed Email dispatch over the existing Work lifecycle and State join. */
import type { OutboxId, OutboxIntent, ReceiptResultContext, StoragePort, RecordId } from '@canlang/contracts';
import { createReceiptJoinPort } from '@canlang/state/receipt/tables';
import type { SystemCommandDef } from '@canlang/state/ports/system';
import { dispatchByStateQuery, WORK_DISPATCH_MODEL } from '@canlang/work/kernel/tables';
import { assembleDispatchCommands } from '../worker/assembly.js';
import type { BoundMailAdapter } from './bound-mail.js';
import { stageReceiptProgress } from './receipt-progress.js';
import type { BoundTextGenerationAdapter, TextRunWire } from './bound-text-generation.js';
import { readRetainedTextGenerationEvidence, readRetainedTextGenerationReceipt,
  stageTextGenerationProgress } from './text-generation-progress.js';
import {
  driveDispatchIntent,
  loadDispatchSystemProducers,
  loadFenceAdmissionProducer,
  readDispatchExecutionRow,
  runRecoverySweep,
  type CheckedDeliveryProgressProducer,
  withDispatchJoinPort,
} from './invoke.js';
import type {
  DispatchReconcileEvidence,
  DispatchProviderOutcome,
  DispatchWorkerCommand,
  DriveDispatchFenceInput,
  DriveDispatchIntentOpts,
  DriveDispatchOutcome,
  RecoverySweepOpts,
  RecoverySweepResult,
} from './invoke.js';

export interface BoundMailDispatcherOptions {
  readonly store: StoragePort;
  readonly adapter: BoundMailAdapter;
  readonly workCommands: readonly DispatchWorkerCommand[];
  readonly stageCommands: readonly DispatchWorkerCommand[];
  /** The defining Work factory; availability must precede claim writes. */
  readonly createClaimCommand: (
    available: (intentId: OutboxId, target: string) => boolean,
  ) => DispatchWorkerCommand;
}

export type BoundMailDriveOptions = Omit<DriveDispatchIntentOpts,
  'registry' | 'store' | 'intent' | 'callProvider' | 'fence'> & {
  readonly intentId: string;
  readonly fence: DriveDispatchFenceInput;
};

export type BoundMailDriveOutcome = DriveDispatchOutcome
  | { readonly status: 'not-pending'; readonly intentId: string }
  | { readonly status: 'unavailable'; readonly intentId: string; readonly target: string }
  | { readonly status: 'refused-inherited-scope'; readonly intentId: string;
      readonly fence: { readonly checkpoint: { readonly revision: number; readonly owner: string };
        readonly triggerRevision: { readonly revision: number } } };

export type BoundMailRecoveryOptions = Omit<RecoverySweepOpts,
  'registry' | 'store' | 'joinPort' | 'readEvidence'>;

export interface BoundMailDispatcher {
  drive(options: BoundMailDriveOptions): Promise<BoundMailDriveOutcome>;
  recover(options: BoundMailRecoveryOptions): Promise<RecoverySweepResult>;
}

export interface BoundTextGenerationDispatcherOptions extends Omit<BoundMailDispatcherOptions, 'adapter'> {
  readonly adapter: BoundTextGenerationAdapter;
  readonly progressed?: CheckedDeliveryProgressProducer;
}

/** Both installations use the same defining claim, record, recovery and fence. */
export function createBoundTextGenerationDispatcher(options: BoundTextGenerationDispatcherOptions): Promise<BoundMailDispatcher> {
  return createInstalledDispatcher({ ...options, textAdapter: options.adapter });
}

/**
 * One existing registry composition. This selected installation supplies real
 * Work commands; it does not install a provider or introduce a second lifecycle.
 */
export async function createBoundMailDispatcher(
  options: BoundMailDispatcherOptions,
): Promise<BoundMailDispatcher> {
  return createInstalledDispatcher(options);
}

function sameRetainedTextEvidence(expected: DispatchReconcileEvidence,
  actual: DispatchReconcileEvidence | null, context: ReceiptResultContext): boolean {
  return expected.kind === 'failed' && actual?.kind === 'failed'
    ? expected.code === actual.code && expected.message === actual.message
    : expected.kind === 'delivered' && actual?.kind === 'delivered' &&
      context.declaredResult!.fields.every(leaf =>
        (expected.result as TextRunWire)[leaf.name as keyof TextRunWire] ===
        (actual.result as TextRunWire)[leaf.name as keyof TextRunWire]);
}

async function createInstalledDispatcher(
  options: BoundMailDispatcherOptions & { readonly textAdapter?: BoundTextGenerationAdapter;
    readonly progressed?: CheckedDeliveryProgressProducer },
): Promise<BoundMailDispatcher> {
  const producers = await loadDispatchSystemProducers();
  const pending = new Map<string, OutboxIntent>();
  const resultContexts = new Map<string, ReceiptResultContext>();
  const claim = options.createClaimCommand((id, target) => {
    const intent = pending.get(id);
    return intent !== undefined && intent.target === target && options.adapter.available(intent);
  });
  if (claim.name !== 'work.dispatch.claim' ||
      options.workCommands.filter(command => command.name === claim.name).length !== 1) {
    throw new Error('Installed mail dispatch needs exactly one defining Work claim command.');
  }
  const recordCommands = options.workCommands.filter(command => command.name === 'work.dispatch.record-attempt');
  const originalRecord = recordCommands[0] as SystemCommandDef | undefined;
  if (recordCommands.length !== 1 || typeof originalRecord?.stage !== 'function') {
    throw new Error('Installed mail dispatch needs exactly one defining Work record command.');
  }
  // The actual call result remains local to its held claim. Work owns all
  // lifecycle admission; this wrapper adds only the receipt writes after it.
  const completions = new Map<string, { intent: OutboxIntent; outcome: DispatchProviderOutcome;
    owner: string;
    progressCommitted?: boolean; retainedEvidence?: DispatchReconcileEvidence }>();
  const record: SystemCommandDef = {
    name: originalRecord.name,
    async stage(args, ctx) {
      const staged = await originalRecord.stage(args, ctx);
      const completion = completions.get(`${String(args['intentId'])}\0${String(args['claimId'])}`);
      const outcome = args['outcome'];
      if (completion === undefined || typeof outcome !== 'object' || outcome === null ||
          !staged.outboxAck?.includes(completion.intent.intentId)) return staged;
      if (completion.retainedEvidence !== undefined) {
        const context = requireResultContext(completion.intent.intentId);
        const current = await readRetainedTextGenerationEvidence({ intent: completion.intent, context }, ctx);
        if (!sameRetainedTextEvidence(completion.retainedEvidence, current, context)) {
          throw new Error('Retained text outcome changed before acknowledgement.');
        }
      }
      // The installed stream awaited this exact final observation's fenced
      // commit. Recording its attempt only acknowledges the same original
      // intent; it must not create a second checkpoint for that sequence.
      if (completion.progressCommitted === true) return staged;
      const recorded = outcome as Record<string, unknown>;
      const selected = completion.outcome.kind === 'delivered' && recorded['state'] === 'delivered'
        ? { kind: 'delivered' as const, result: completion.outcome.result }
        : completion.outcome.kind === 'failed' && recorded['state'] === 'failed' &&
          recorded['retryClass'] === 'terminal' && typeof recorded['errorCode'] === 'string' &&
          typeof recorded['errorMessage'] === 'string'
        ? { kind: 'failed' as const, error: { code: recorded['errorCode'], message: recorded['errorMessage'] } }
        : null;
      if (selected === null) return staged;
      const revision = (await options.store.readRevision()) + 1;
      const receipt = options.textAdapter === undefined
        ? await stageReceiptProgress({ intent: completion.intent, outcome: selected, revision }, ctx)
        : await stageTextGenerationProgress({ intent: completion.intent,
          context: requireResultContext(completion.intent.intentId), revision,
          ...(options.progressed === undefined ? {} : { progressed: { producer: options.progressed, owner: completion.owner } }),
          ...(selected.kind === 'delivered' ? { progress: selected.result as TextRunWire } : { outcome: selected }) }, ctx);
      return { ...staged, writes: [...(staged.writes ?? []), ...(receipt.writes ?? [])],
        schedules: [...staged.schedules ?? [], ...receipt.schedules ?? []] };
    },
  };
  const requireResultContext = (id: string): ReceiptResultContext => {
    const context = resultContexts.get(id);
    if (context === undefined) throw new Error('Text progress lost its verified original request.');
    return context;
  };
  const progressCommand: SystemCommandDef = {
    name: 'work.text.progress',
    async stage(args, ctx) {
      const intent = pending.get(String(args['intentId']));
      if (intent === undefined || options.textAdapter === undefined) throw new Error('Text progress needs its original pending intent.');
      const claimRow = await ctx.load(WORK_DISPATCH_MODEL, intent.intentId as RecordId);
      if (claimRow === null) throw new Error('Text progress lost its held claim.');
      const held = readDispatchExecutionRow(claimRow);
      if (held.state !== 'claimed' || held.claimId !== args['claimId']) throw new Error('Text progress needs its current held claim.');
      const owner = progressOwners.get(`${intent.intentId}\0${held.claimId}`);
      if (owner === undefined) throw new Error('Text progress lost its admitted owner fence.');
      return stageTextGenerationProgress({ intent, context: requireResultContext(intent.intentId),
        ...(options.progressed === undefined ? {} : { progressed: { producer: options.progressed, owner } }),
        progress: args['progress'] as TextRunWire, revision: (await options.store.readRevision()) + 1 }, ctx);
    },
  };
  const progressOwners = new Map<string, string>();
  const registry = producers.createSystemRegistry(assembleDispatchCommands({
    l3Commands: producers.l3Commands,
    workCommands: [...options.workCommands.map(command => command.name === claim.name ? claim
      : command.name === record.name ? record : command), ...(options.textAdapter === undefined ? [] : [progressCommand])],
    stageCommands: options.stageCommands,
  }));
  const receiptStore = withDispatchJoinPort(options.store, createReceiptJoinPort({ store: options.store,
    ...(options.textAdapter === undefined ? {} : { resultContexts: () => resultContexts }) }));
  const joinPort = producers.createDispatchJoinPort({ store: receiptStore });
  const store = withDispatchJoinPort(options.store, joinPort);
  const refreshPending = async (): Promise<void> => {
    const rows = await store.outboxPending();
    const previous = [...pending.values()];
    pending.clear();
    for (const intent of rows) {
      pending.set(intent.intentId, intent);
      const context = options.textAdapter?.resultContext(intent);
      if (context !== undefined && context !== null) resultContexts.set(intent.intentId, context);
    }
    for (const intent of previous) {
      if (!pending.has(intent.intentId)) options.textAdapter?.releaseAcknowledged(intent);
    }
    for (const id of resultContexts.keys()) {
      if (!pending.has(id)) resultContexts.delete(id);
    }
  };
  return {
    async drive(input) {
      await refreshPending();
      const intent = pending.get(input.intentId);
      if (intent === undefined) return { status: 'not-pending', intentId: input.intentId };
      // A trigger's own checkpoint cannot authorize a transitive effect. Check
      // this prefix before deployment availability or any dynamic authority read.
      const trigger = input.fence.triggerRevision;
      if (trigger !== undefined) {
        if (!Number.isInteger(trigger.revision) || trigger.revision < 0 || input.fence.owner === '') {
          throw new Error('Installed mail dispatch needs a valid owner and trigger revision.');
        }
        const admission = await loadFenceAdmissionProducer();
        const checkpoint = (await admission.openTransitiveScope(store, input.fence.owner)).snapshot();
        if (checkpoint.revision === trigger.revision) {
          return { status: 'refused-inherited-scope', intentId: intent.intentId,
            fence: { checkpoint, triggerRevision: trigger } };
        }
      }
      const heldKeys: string[] = [];
      try {
        const outcome = await driveDispatchIntent({ ...input, registry, store, intent,
          callProvider: async (selected, held) => {
            const heldKey = `${selected.intentId}\0${held.claimId}`;
            progressOwners.set(heldKey, input.fence.owner);
            heldKeys.push(heldKey);
            let committedProgress: TextRunWire | undefined;
            let retainedCommitted = false;
            let retainedEvidence: DispatchReconcileEvidence | undefined;
            let answer: DispatchProviderOutcome;
            const context = options.textAdapter === undefined ? null : requireResultContext(selected.intentId);
            const scope = { actor: input.actor, now: input.nowMs(), operation: input.operation,
              load: store.load.bind(store), query: store.query.bind(store) };
            const retained = context === null ? null
              : await readRetainedTextGenerationReceipt({ intent: selected, context }, scope);
            if (context !== null && retained === null) {
              throw new Error('Text generation needs its original durable receipt before transport.');
            }
            if (context !== null && retained !== null && (retained.result !== null || retained.status !== 'pending')) {
              // A reclaimed claim never restarts a run which already crossed
              // the durable pre-transport queue boundary. Only confirmed
              // original terminal evidence can settle that uncertain attempt.
              const definitive = await readRetainedTextGenerationEvidence({ intent: selected, context }, scope);
              retainedCommitted = definitive !== null;
              retainedEvidence = definitive ?? undefined;
              answer = definitive?.kind === 'delivered' ? definitive
                : definitive?.kind === 'failed' ? { kind: 'failed', cause: { kind: 'permanent',
                    code: definitive.code, message: definitive.message } }
                : { kind: 'uncertain' };
            } else answer = options.textAdapter === undefined ? await options.adapter.callProvider(selected)
              : await options.textAdapter.callProvider(selected, { onProgress: async progress => {
                await registry.run(progressCommand.name, { intentId: selected.intentId, claimId: held.claimId, progress },
                  { actor: input.actor, now: input.nowMs(), operation: input.operation,
                    operationId: `${held.claimId}:progress:${progress.sequence}` }, { store });
                committedProgress = progress;
              } });
            const key = `${selected.intentId}\0${held.claimId}`;
            completions.set(key, { intent: selected, outcome: answer, owner: input.fence.owner,
              ...(retainedEvidence === undefined ? {} : { retainedEvidence }),
              progressCommitted: retainedCommitted || answer.kind === 'delivered' &&
                committedProgress !== undefined && answer.result === committedProgress });
            return answer;
          } });
        await refreshPending();
        return outcome.status === 'not-claimed' && outcome.reason === 'unavailable'
          ? { status: 'unavailable', intentId: intent.intentId, target: intent.target }
          : outcome;
      } finally {
        for (const key of heldKeys) { completions.delete(key); progressOwners.delete(key); }
      }
    },
    async recover(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1) {
        throw new Error('Installed mail recovery needs a positive integer scan limit.');
      }
      // Services is asynchronous, while Work's planner reads evidence
      // synchronously. Only confirmed evidence crosses this small join.
      await refreshPending();
      const evidence = new Map<string, DispatchReconcileEvidence>();
      const retainedEvidence = new Set<string>();
      const retainedContext = { actor: input.actor, now: input.nowMs(), operation: input.operation,
        load: store.load.bind(store), query: store.query.bind(store) };
      // The existing recovery planner selects its bounded page by intent ID.
      // Fetch that same page, rather than D1's default creation-time order.
      const rows = await store.query({ ...dispatchByStateQuery('uncertain'),
        order: [{ field: 'id', direction: 'asc' }], limit: input.limit });
      for (const row of rows) {
        const dispatch = readDispatchExecutionRow(row);
        if (dispatch.state !== 'uncertain') continue;
        const intent = pending.get(dispatch.intentId);
        if (intent === undefined || !options.adapter.available(intent)) continue;
        const retained = options.textAdapter === undefined ? null
          : await readRetainedTextGenerationEvidence({ intent,
            context: requireResultContext(intent.intentId) }, retainedContext);
        const answer = retained ?? await options.adapter.reconcile(intent);
        if (retained !== null) retainedEvidence.add(intent.intentId);
        if (answer !== null) evidence.set(intent.intentId, answer);
      }
      const outcome = await runRecoverySweep({ ...input, registry, store, joinPort,
        readEvidence: id => evidence.get(id) ?? null,
        stageReconciledReceipt: async ({ intentId, evidence: answer, revision, context }) => {
          const intent = pending.get(intentId);
          if (intent === undefined || !options.adapter.available(intent)) {
            throw new Error('Reconciled mail lost its installed original intent.');
          }
          if (retainedEvidence.has(intentId)) {
            // Re-read the original terminal receipt in the recovery batch's
            // scope. Its progress was already committed: only acknowledge the
            // intent, without giving that same sequence a new checkpoint.
            const checkedContext = requireResultContext(intentId);
            const retained = await readRetainedTextGenerationEvidence({ intent, context: checkedContext }, context);
            if (!sameRetainedTextEvidence(answer, retained, checkedContext)) {
              throw new Error('Retained text outcome changed before acknowledgement.');
            }
            return [];
          }
          const outcome = answer.kind === 'delivered'
            ? { kind: 'delivered' as const, result: answer.result }
            : { kind: 'failed' as const, error: { code: answer.code, message: answer.message } };
          if (options.progressed !== undefined) {
            throw new Error('New recovered progress needs the original admitted owner fence before occurrence staging.');
          }
          return (options.textAdapter === undefined
            ? await stageReceiptProgress({ intent, outcome, revision }, context)
            : await stageTextGenerationProgress({ intent, context: requireResultContext(intent.intentId), revision,
              ...(outcome.kind === 'delivered' ? { progress: outcome.result as TextRunWire } : { outcome }) }, context)).writes ?? [];
        } });
      await refreshPending();
      return outcome;
    },
  };
}
