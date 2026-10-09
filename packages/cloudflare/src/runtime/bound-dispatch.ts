/** Installed provider dispatch over the existing Work lifecycle and State join. */
import type { OutboxId, OutboxIntent, ReceiptResultContext, StoragePort, RecordId, AssociatedReceipt, StoredRow, RetainedOutboxIntent } from '@canlang/contracts';
import { createReceiptJoinPort } from '@canlang/state/receipt/tables';
import { decodeValue, equalValue } from '@canlang/values';
import type { SystemCommandContext } from '@canlang/state';
import type { SystemCommandDef } from '@canlang/state/ports/system';
import { dispatchByStateQuery, WORK_DISPATCH_MODEL, readDispatchRow, readDispatchImageCorrelation,
  DISPATCH_IMAGE_CORRELATION_FIELDS, type DispatchImageCorrelation, type DispatchRowData } from '@canlang/work/kernel/tables';
import { deriveOutboxId } from '@canlang/work/intent';
import { assembleDispatchCommands } from '../worker/assembly.js';
import type { BoundMailAdapter } from './bound-mail.js';
import type { BoundJudgmentAdapter } from './bound-judgment.js';
import { stageReceiptProgress } from './receipt-progress.js';
import type { BoundTextGenerationAdapter, TextRunWire } from './bound-text-generation.js';
import type { BoundImagesAdapter, ImageRunWire } from './bound-images.js';
import { readRetainedTextGenerationEvidence, readRetainedTextGenerationReceipt,
  readRetainedImageGenerationEvidence, readRetainedImageGenerationReceipt,
  stageTextGenerationProgress, stageImageGenerationProgress } from './text-generation-progress.js';
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

export type RetainedImagesDispatchLookup =
  | { readonly status: 'resolved'; readonly row: StoredRow; readonly dispatch: DispatchRowData;
      readonly retained: RetainedOutboxIntent; readonly principal: string }
  | { readonly status: 'absent' | 'ambiguous' | 'invalid' };

/**
 * Exact owner-local correlation read, including acknowledged originals.
 * This read grants no authority: the control consumer must still qualify the
 * current association, principal/cleanup authority and its own owner fence.
 */
export async function lookupRetainedImagesDispatch(input: {
  readonly store: StoragePort;
  readonly correlation: DispatchImageCorrelation;
}): Promise<RetainedImagesDispatchLookup> {
  const requested = readDispatchImageCorrelation(input.correlation as unknown as Readonly<Record<string, unknown>>);
  if (requested === null) return { status: 'invalid' };
  const rows = await input.store.query({ model: WORK_DISPATCH_MODEL, authority: 'owner',
    where: { op: 'and', args: [
      { op: 'eq', field: 'source', value: 'std.ImagesV1.submit' },
      ...DISPATCH_IMAGE_CORRELATION_FIELDS.map(field => ({ op: 'eq' as const, field, value: requested[field] })),
    ] }, order: [{ field: 'id', direction: 'asc' }], limit: 2 });
  if (rows.length === 0) return { status: 'absent' };
  if (rows.length > 1) return { status: 'ambiguous' };
  const row = rows[0]!;
  try {
    const dispatch = readDispatchRow(row);
    if (row.id !== dispatch.intentId || dispatch.source !== 'std.ImagesV1.submit' ||
        DISPATCH_IMAGE_CORRELATION_FIELDS.some(field => dispatch[field] !== requested[field]) ||
        row.archivedAt !== null || typeof row.createdBy !== 'string' || row.createdBy === '' ||
        !Number.isSafeInteger(row.created) || row.created < 0) return { status: 'invalid' };
    const retained = await input.store.outboxGet(dispatch.intentId);
    if (retained === null || !['pending', 'dispatched', 'skipped'].includes(retained.status)) return { status: 'invalid' };
    const intent = retained.intent;
    if (intent.intentId !== dispatch.intentId || intent.target !== dispatch.source ||
        intent.operationId !== dispatch.operationId || intent.occurrenceIndex !== dispatch.occurrenceIndex ||
        deriveOutboxId(intent.operationId, intent.target, intent.occurrenceIndex) !== intent.intentId) return { status: 'invalid' };
    const carrier = intent.arguments;
    const args = carrier['arguments'];
    if (Object.keys(carrier).length !== 3 || carrier['binding'] !== requested.requestBinding ||
        carrier['from'] !== requested.requestFrom || typeof args !== 'object' || args === null || Array.isArray(args) ||
        Object.keys(args).length !== 1 || !Object.hasOwn(args, 'value')) return { status: 'invalid' };
    const value = (args as Record<string, unknown>)['value'];
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
        (value as Record<string, unknown>)['source'] !== requested.requestSource ||
        (value as Record<string, unknown>)['revision'] !== requested.requestRevision) return { status: 'invalid' };
    return { status: 'resolved', row, dispatch, retained, principal: row.createdBy };
  } catch { return { status: 'invalid' }; }
}

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
  'registry' | 'store' | 'joinPort' | 'readEvidence' | 'revalidateReconciledReceipt'> & {
  /** Images observation and acknowledgement use the actual current host fence. */
  readonly admission?: Pick<BoundMailDriveOptions, 'fence' | 'evaluateGuard' | 'readStateSnapshot'>;
};

export interface BoundMailDispatcher {
  drive(options: BoundMailDriveOptions): Promise<BoundMailDriveOutcome>;
  recover(options: BoundMailRecoveryOptions): Promise<RecoverySweepResult>;
}

export interface BoundTextGenerationDispatcherOptions extends Omit<BoundMailDispatcherOptions, 'adapter'> {
  readonly adapter: BoundTextGenerationAdapter;
  readonly progressed?: CheckedDeliveryProgressProducer;
}

export interface BoundImagesDispatcherOptions extends Omit<BoundMailDispatcherOptions, 'adapter'> {
  readonly adapter: BoundImagesAdapter;
  readonly progressed?: CheckedDeliveryProgressProducer;
}

export interface BoundJudgmentDispatcherOptions extends Omit<BoundMailDispatcherOptions, 'adapter'> {
  readonly adapter: BoundJudgmentAdapter;
}

type InstalledDispatcherOptions =
  | (BoundMailDispatcherOptions & { readonly profile: 'mail' })
  | (BoundTextGenerationDispatcherOptions & { readonly profile: 'text' })
  | (BoundImagesDispatcherOptions & { readonly profile: 'images' })
  | (BoundJudgmentDispatcherOptions & { readonly profile: 'judgment' });
type RichRunWire = TextRunWire | ImageRunWire;

/** All installations use the same defining claim, record, recovery and fence. */
export function createBoundTextGenerationDispatcher(options: BoundTextGenerationDispatcherOptions): Promise<BoundMailDispatcher> {
  return createInstalledDispatcher({ ...options, profile: 'text' });
}

export function createBoundImagesDispatcher(options: BoundImagesDispatcherOptions): Promise<BoundMailDispatcher> {
  return createInstalledDispatcher({ ...options, profile: 'images' });
}

export function createBoundJudgmentDispatcher(options: BoundJudgmentDispatcherOptions): Promise<BoundMailDispatcher> {
  return createInstalledDispatcher({ ...options, profile: 'judgment' });
}

/**
 * One existing registry composition. This selected installation supplies real
 * Work commands; it does not install a provider or introduce a second lifecycle.
 */
export async function createBoundMailDispatcher(
  options: BoundMailDispatcherOptions,
): Promise<BoundMailDispatcher> {
  return createInstalledDispatcher({ ...options, profile: 'mail' });
}

function sameRetainedEvidence(expected: DispatchReconcileEvidence,
  actual: DispatchReconcileEvidence | null, context: ReceiptResultContext, profile: 'text' | 'images'): boolean {
  return expected.kind === 'failed' && actual?.kind === 'failed'
    ? expected.code === actual.code && expected.message === actual.message
    : expected.kind === 'delivered' && actual?.kind === 'delivered' &&
      context.declaredResult!.fields.every(leaf => {
        const before = (expected.result as unknown as Record<string, unknown>)[leaf.name];
        const after = (actual.result as unknown as Record<string, unknown>)[leaf.name];
        // Image outputs are ordered, nested File wire values. Compare their
        // owning declared codecs, including every leaf, rather than identity.
        return profile === 'text' ? before === after
          : equalValue(leaf.type, decodeValue(leaf.type, before), decodeValue(leaf.type, after));
      });
}

async function createInstalledDispatcher(
  options: InstalledDispatcherOptions,
): Promise<BoundMailDispatcher> {
  const rich = options.profile === 'text' || options.profile === 'images';
  const typed = options.profile !== 'mail';
  const progressed = options.profile === 'text' || options.profile === 'images' ? options.progressed : undefined;
  const readRetainedReceipt = options.profile === 'images'
    ? readRetainedImageGenerationReceipt : readRetainedTextGenerationReceipt;
  const readRetainedEvidence = options.profile === 'images'
    ? readRetainedImageGenerationEvidence : readRetainedTextGenerationEvidence;
  const stageRichProgress = (input: { intent: OutboxIntent; context: ReceiptResultContext; revision: number;
    progressed?: { producer: CheckedDeliveryProgressProducer; owner: string } } & (
      { progress: RichRunWire; outcome?: never } |
      { outcome: { kind: 'failed'; error: { code: string; message: string } }; progress?: never }),
    ctx: SystemCommandContext) => options.profile === 'images'
      ? stageImageGenerationProgress({ ...input,
          ...(input.progress === undefined ? {} : { progress: input.progress as ImageRunWire }) } as Parameters<typeof stageImageGenerationProgress>[0], ctx)
      : stageTextGenerationProgress({ ...input,
          ...(input.progress === undefined ? {} : { progress: input.progress as TextRunWire }) } as Parameters<typeof stageTextGenerationProgress>[0], ctx);
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
        const current = await readRetainedEvidence({ intent: completion.intent, context }, ctx);
        if (!sameRetainedEvidence(completion.retainedEvidence, current, context, options.profile === 'images' ? 'images' : 'text')) {
          throw new Error('Retained generation outcome changed before acknowledgement.');
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
      const receipt = !rich
        ? await stageReceiptProgress({ intent: completion.intent, outcome: selected, revision,
          ...(options.profile === 'judgment' ? { context: requireResultContext(completion.intent.intentId) } : {}) }, ctx)
        : await stageRichProgress({ intent: completion.intent,
          context: requireResultContext(completion.intent.intentId), revision,
          ...(progressed === undefined ? {} : { progressed: { producer: progressed, owner: completion.owner } }),
          ...(selected.kind === 'delivered' ? { progress: selected.result as RichRunWire } : { outcome: selected }) }, ctx);
      return { ...staged, writes: [...(staged.writes ?? []), ...(receipt.writes ?? [])],
        schedules: [...staged.schedules ?? [], ...receipt.schedules ?? []] };
    },
  };
  const requireResultContext = (id: string): ReceiptResultContext => {
    const context = resultContexts.get(id);
    if (context === undefined) throw new Error('Generation progress lost its verified original request.');
    return context;
  };
  const progressCommand: SystemCommandDef = {
    name: options.profile === 'images' ? 'work.image.progress' : 'work.text.progress',
    async stage(args, ctx) {
      const intent = pending.get(String(args['intentId']));
      if (intent === undefined || !rich) throw new Error('Generation progress needs its original pending intent.');
      const claimRow = await ctx.load(WORK_DISPATCH_MODEL, intent.intentId as RecordId);
      if (claimRow === null) throw new Error('Generation progress lost its held claim.');
      const held = readDispatchExecutionRow(claimRow);
      if (held.state !== 'claimed' || held.claimId !== args['claimId']) throw new Error('Generation progress needs its current held claim.');
      const owner = progressOwners.get(`${intent.intentId}\0${held.claimId}`);
      if (owner === undefined) throw new Error('Generation progress lost its admitted owner fence.');
      return stageRichProgress({ intent, context: requireResultContext(intent.intentId),
        ...(progressed === undefined ? {} : { progressed: { producer: progressed, owner } }),
        progress: args['progress'] as RichRunWire, revision: (await options.store.readRevision()) + 1 }, ctx);
    },
  };
  const progressOwners = new Map<string, string>();
  const registry = producers.createSystemRegistry(assembleDispatchCommands({
    l3Commands: producers.l3Commands,
    workCommands: [...options.workCommands.map(command => command.name === claim.name ? claim
      : command.name === record.name ? record : command), ...(!rich ? [] : [progressCommand])],
    stageCommands: options.stageCommands,
  }));
  const receiptStore = withDispatchJoinPort(options.store, createReceiptJoinPort({ store: options.store,
    ...(!typed ? {} : { resultContexts: () => resultContexts }) }));
  const joinPort = producers.createDispatchJoinPort({ store: receiptStore });
  const store = withDispatchJoinPort(options.store, joinPort);
  const refreshPending = async (): Promise<void> => {
    const rows = await store.outboxPending();
    const previous = [...pending.values()];
    pending.clear();
    for (const intent of rows) {
      pending.set(intent.intentId, intent);
      const context = options.profile === 'mail' ? null : options.adapter.resultContext(intent);
      if (context !== undefined && context !== null) resultContexts.set(intent.intentId, context);
    }
    for (const intent of previous) {
      if (!pending.has(intent.intentId) && options.profile === 'text') options.adapter.releaseAcknowledged(intent);
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
            let committedProgress: RichRunWire | undefined;
            let retainedCommitted = false;
            let retainedEvidence: DispatchReconcileEvidence | undefined;
            let answer: DispatchProviderOutcome;
            const context = !rich ? null : requireResultContext(selected.intentId);
            const scope = { actor: input.actor, now: input.nowMs(), operation: input.operation,
              load: store.load.bind(store), query: store.query.bind(store) };
            const retained = context === null ? null
              : await readRetainedReceipt({ intent: selected, context }, scope);
            if (context !== null && retained === null) {
              throw new Error('Generation needs its original durable receipt before transport.');
            }
            if (context !== null && retained !== null && (retained.result !== null || retained.status !== 'pending')) {
              // A reclaimed claim never restarts a run which already crossed
              // the durable pre-transport queue boundary. Only confirmed
              // original terminal evidence can settle that uncertain attempt.
              const definitive = await readRetainedEvidence({ intent: selected, context }, scope);
              retainedCommitted = definitive !== null;
              retainedEvidence = definitive ?? undefined;
              answer = definitive?.kind === 'delivered' ? definitive
                : definitive?.kind === 'failed' ? { kind: 'failed', cause: { kind: 'permanent',
                    code: definitive.code, message: definitive.message } }
                : { kind: 'uncertain' };
            } else {
              const commitProgress = async (progress: RichRunWire): Promise<void> => {
                await registry.run(progressCommand.name, { intentId: selected.intentId, claimId: held.claimId, progress },
                  { actor: input.actor, now: input.nowMs(), operation: input.operation,
                    operationId: `${held.claimId}:progress:${progress.sequence}` }, { store });
                committedProgress = progress;
              };
              if (options.profile === 'mail' || options.profile === 'judgment') answer = await options.adapter.callProvider(selected);
              else if (options.profile === 'text') answer = await options.adapter.callProvider(selected, { onProgress: commitProgress });
              else {
                const original = await store.load(WORK_DISPATCH_MODEL, selected.intentId as RecordId);
                if (original === null) throw new Error('Images transport lost its original staged attempt.');
                const execution = readDispatchExecutionRow(original);
                if (execution.state !== 'claimed' || execution.claimId !== held.claimId) {
                  throw new Error('Images transport needs its current held claim.');
                }
                answer = await options.adapter.callProvider(selected, { stagedAtMs: original.created,
                  onQueued: commitProgress, onProgress: commitProgress });
              }
            }
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
      const admitImagesRecovery = async (intent: OutboxIntent, expectedRevision?: number) => {
        const admitted = input.admission;
        if (admitted === undefined || admitted.fence.owner === '' ||
            typeof admitted.fence.revalidateAuthority !== 'function' ||
            typeof admitted.evaluateGuard !== 'function' || typeof admitted.readStateSnapshot !== 'function') {
          throw new Error('Images recovery requires its actual current host owner admission.');
        }
        const producer = await loadFenceAdmissionProducer();
        const checkpoint = (await producer.openTransitiveScope(store, admitted.fence.owner)).snapshot();
        const trigger = admitted.fence.triggerRevision;
        if (trigger !== undefined && (!Number.isSafeInteger(trigger.revision) || trigger.revision < 0 ||
            checkpoint.revision === trigger.revision)) {
          throw new Error('Images recovery cannot inherit its triggering checkpoint.');
        }
        const guard = intent.dispatchGuard ?? null;
        const snapshot = guard === null ? null : await admitted.readStateSnapshot(intent);
        if (guard !== null && admitted.evaluateGuard(guard, intent.arguments, snapshot) !== true) {
          throw new Error('Images recovery original dispatch guard no longer holds.');
        }
        if (await admitted.fence.revalidateAuthority() !== true) {
          throw new Error('Images recovery current authority was revoked.');
        }
        if (await store.readRevision() !== checkpoint.revision ||
            (expectedRevision !== undefined && checkpoint.revision !== expectedRevision)) {
          throw new Error('Images recovery admission revision changed.');
        }
        return checkpoint;
      };
      // Services is asynchronous, while Work's planner reads evidence
      // synchronously. Only confirmed evidence crosses this small join.
      await refreshPending();
      const evidence = new Map<string, DispatchReconcileEvidence>();
      const retainedEvidence = new Set<string>();
      const imageObservations = new Map<string, { receipt: AssociatedReceipt; progress: ImageRunWire }>();
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
        if (options.profile === 'images') await admitImagesRecovery(intent);
        const retained = !rich ? null
          : await readRetainedEvidence({ intent,
            context: requireResultContext(intent.intentId) }, retainedContext);
        let answer = retained;
        if (answer === null) {
          if (options.profile !== 'images') answer = await options.adapter.reconcile(intent);
          else {
            const receipt = await readRetainedReceipt({ intent,
              context: requireResultContext(intent.intentId) }, retainedContext);
            if (receipt === null) throw new Error('Images recovery lost its original durable receipt.');
            const sequence = receipt.result === null ? undefined
              : (receipt.result as unknown as ImageRunWire).sequence;
            let observed: ImageRunWire | undefined;
            answer = await options.adapter.reconcile(intent, {
              stagedAtMs: row.created, ...(sequence === undefined ? {} : { sequence }),
              onQueued: async () => { throw new Error('Images recovery cannot submit a new job.'); },
              // Reconciliation only observes the original installed job. Its
              // confirmed terminal evidence is staged in the existing recovery
              // batch below; nonterminal observations never authorize ack.
              onProgress: async progress => { observed = progress; },
            });
            if (answer?.kind === 'delivered') {
              const checkedContext = requireResultContext(intent.intentId);
              if (observed === undefined || !['succeeded', 'failed', 'cancelled'].includes(observed.state) ||
                  !sameRetainedEvidence(answer, { kind: 'delivered', result: observed }, checkedContext, 'images')) {
                throw new Error('Images recovery needs its actual confirmed terminal observation.');
              }
              imageObservations.set(intent.intentId, { receipt, progress: observed });
            }
          }
        }
        if (retained !== null) retainedEvidence.add(intent.intentId);
        if (answer !== null) evidence.set(intent.intentId, answer);
      }
      const outcome = await runRecoverySweep({ ...input, registry, store, joinPort,
        readEvidence: id => evidence.get(id) ?? null,
        ...(options.profile !== 'images' ? {} : { revalidateReconciledReceipt: async (
          { intentId, revision }: { readonly intentId: string; readonly revision: number },
        ) => {
          const intent = pending.get(intentId);
          if (intent === undefined || !options.adapter.available(intent)) {
            throw new Error('Images recovery acknowledgement lost its original pending intent.');
          }
          await admitImagesRecovery(intent, revision);
        } }),
        stageReconciledReceipt: async ({ intentId, evidence: answer, revision, context }) => {
          const intent = pending.get(intentId);
          if (intent === undefined || !options.adapter.available(intent)) {
            throw new Error('Reconciled mail lost its installed original intent.');
          }
          const admitted = options.profile === 'images' ? await admitImagesRecovery(intent, revision - 1) : undefined;
          if (retainedEvidence.has(intentId)) {
            // Re-read the original terminal receipt in the recovery batch's
            // scope. Its progress was already committed: only acknowledge the
            // intent, without giving that same sequence a new checkpoint.
            const checkedContext = requireResultContext(intentId);
            const retained = await readRetainedEvidence({ intent, context: checkedContext }, context);
            if (!sameRetainedEvidence(answer, retained, checkedContext, options.profile === 'images' ? 'images' : 'text')) {
              throw new Error('Retained generation outcome changed before acknowledgement.');
            }
            return [];
          }
          const observation = imageObservations.get(intentId);
          if (observation !== undefined) {
            const checkedContext = requireResultContext(intentId);
            const current = await readRetainedReceipt({ intent, context: checkedContext }, context);
            const previous = observation.receipt;
            // The actual provider observation was based on this original
            // sequence. A concurrent receipt change must not be overwritten or
            // silently acknowledged by the terminal-only recovery batch.
            if (current === null || current.status !== previous.status ||
                current.error?.code !== previous.error?.code || current.error?.message !== previous.error?.message ||
                (current.result === null ? previous.result !== null : previous.result === null ||
                  !sameRetainedEvidence({ kind: 'delivered', result: previous.result },
                    { kind: 'delivered', result: current.result }, checkedContext, 'images')) ||
                !sameRetainedEvidence(answer, { kind: 'delivered', result: observation.progress }, checkedContext, 'images')) {
              throw new Error('Images receipt changed before recovery acknowledgement.');
            }
          }
          const outcome = answer.kind === 'delivered'
            ? { kind: 'delivered' as const, result: answer.result }
            : { kind: 'failed' as const, error: { code: answer.code, message: answer.message } };
          if (progressed !== undefined && admitted === undefined) {
            throw new Error('New recovered progress needs the original admitted owner fence before occurrence staging.');
          }
          return (!rich
            ? await stageReceiptProgress({ intent, outcome, revision,
              ...(options.profile === 'judgment' ? { context: requireResultContext(intent.intentId) } : {}) }, context)
            : await stageRichProgress({ intent, context: requireResultContext(intent.intentId), revision,
              ...(progressed === undefined || admitted === undefined ? {} : {
                progressed: { producer: progressed, owner: admitted.owner },
              }),
              ...(outcome.kind === 'delivered' ? { progress: outcome.result as RichRunWire } : { outcome }) }, context));
        } });
      await refreshPending();
      return outcome;
    },
  };
}
