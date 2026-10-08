/** Installed Email dispatch over the existing Work lifecycle and State join. */
import type { OutboxId, OutboxIntent, StoragePort } from '@canlang/contracts';
import { createReceiptJoinPort } from '@canlang/state/receipt/tables';
import type { SystemCommandDef } from '@canlang/state/ports/system';
import { dispatchByStateQuery } from '@canlang/work/kernel/tables';
import { assembleDispatchCommands } from '../worker/assembly.js';
import type { BoundMailAdapter } from './bound-mail.js';
import { stageReceiptProgress } from './receipt-progress.js';
import {
  driveDispatchIntent,
  loadDispatchSystemProducers,
  loadFenceAdmissionProducer,
  readDispatchExecutionRow,
  runRecoverySweep,
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

/**
 * One existing registry composition. This selected installation supplies real
 * Work commands; it does not install a provider or introduce a second lifecycle.
 */
export async function createBoundMailDispatcher(
  options: BoundMailDispatcherOptions,
): Promise<BoundMailDispatcher> {
  const producers = await loadDispatchSystemProducers();
  const pending = new Map<string, OutboxIntent>();
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
  const completions = new Map<string, { intent: OutboxIntent; outcome: DispatchProviderOutcome }>();
  const record: SystemCommandDef = {
    name: originalRecord.name,
    async stage(args, ctx) {
      const staged = await originalRecord.stage(args, ctx);
      const completion = completions.get(`${String(args['intentId'])}\0${String(args['claimId'])}`);
      const outcome = args['outcome'];
      if (completion === undefined || typeof outcome !== 'object' || outcome === null ||
          !staged.outboxAck?.includes(completion.intent.intentId)) return staged;
      const recorded = outcome as Record<string, unknown>;
      const selected = completion.outcome.kind === 'delivered' && recorded['state'] === 'delivered'
        ? { kind: 'delivered' as const, result: completion.outcome.result }
        : completion.outcome.kind === 'failed' && recorded['state'] === 'failed' &&
          recorded['retryClass'] === 'terminal' && typeof recorded['errorCode'] === 'string' &&
          typeof recorded['errorMessage'] === 'string'
        ? { kind: 'failed' as const, error: { code: recorded['errorCode'], message: recorded['errorMessage'] } }
        : null;
      if (selected === null) return staged;
      const receipt = await stageReceiptProgress({ intent: completion.intent, outcome: selected,
        revision: (await options.store.readRevision()) + 1 }, ctx);
      return { ...staged, writes: [...(staged.writes ?? []), ...(receipt.writes ?? [])] };
    },
  };
  const registry = producers.createSystemRegistry(assembleDispatchCommands({
    l3Commands: producers.l3Commands,
    workCommands: options.workCommands.map(command => command.name === claim.name ? claim
      : command.name === record.name ? record : command),
    stageCommands: options.stageCommands,
  }));
  const receiptStore = withDispatchJoinPort(options.store, createReceiptJoinPort({ store: options.store }));
  const joinPort = producers.createDispatchJoinPort({ store: receiptStore });
  const store = withDispatchJoinPort(options.store, joinPort);
  const refreshPending = async (): Promise<void> => {
    const rows = await store.outboxPending();
    pending.clear();
    for (const intent of rows) pending.set(intent.intentId, intent);
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
            const answer = await options.adapter.callProvider(selected);
            const key = `${selected.intentId}\0${held.claimId}`;
            heldKeys.push(key);
            completions.set(key, { intent: selected, outcome: answer });
            return answer;
          } });
        return outcome.status === 'not-claimed' && outcome.reason === 'unavailable'
          ? { status: 'unavailable', intentId: intent.intentId, target: intent.target }
          : outcome;
      } finally {
        for (const key of heldKeys) completions.delete(key);
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
      // The existing recovery planner selects its bounded page by intent ID.
      // Fetch that same page, rather than D1's default creation-time order.
      const rows = await store.query({ ...dispatchByStateQuery('uncertain'),
        order: [{ field: 'id', direction: 'asc' }], limit: input.limit });
      for (const row of rows) {
        const dispatch = readDispatchExecutionRow(row);
        if (dispatch.state !== 'uncertain') continue;
        const intent = pending.get(dispatch.intentId);
        if (intent === undefined || !options.adapter.available(intent)) continue;
        const answer = await options.adapter.reconcile(intent);
        if (answer !== null) evidence.set(intent.intentId, answer);
      }
      return runRecoverySweep({ ...input, registry, store, joinPort,
        readEvidence: id => evidence.get(id) ?? null,
        stageReconciledReceipt: async ({ intentId, evidence: answer, revision, context }) => {
          const intent = pending.get(intentId);
          if (intent === undefined || !options.adapter.available(intent)) {
            throw new Error('Reconciled mail lost its installed original intent.');
          }
          const outcome = answer.kind === 'delivered'
            ? { kind: 'delivered' as const, result: answer.result }
            : { kind: 'failed' as const, error: { code: answer.code, message: answer.message } };
          return (await stageReceiptProgress({ intent, outcome, revision }, context)).writes ?? [];
        } });
    },
  };
}
