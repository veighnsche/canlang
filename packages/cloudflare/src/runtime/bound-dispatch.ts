/** Installed provider dispatch over the existing Work lifecycle and State join. */
import type { OutboxId, OutboxIntent, ReceiptResultContext, StoragePort, RecordId, ModelName, AssociatedReceipt, StoredRow, RetainedOutboxIntent } from '@canlang/contracts';
import { createReceiptJoinPort, RECEIPT_ASSOCIATION_MODEL, readAssociationRow, withAssociationRowData } from '@canlang/state/receipt/tables';
import { decodeValue, equalValue, isDeliveryRef } from '@canlang/values';
import type { SystemCommandContext, SystemStaging } from '@canlang/state';
import type { SystemCommandDef } from '@canlang/state/ports/system';
import { dispatchByStateQuery, WORK_DISPATCH_MODEL, readDispatchRow, readDispatchImageCorrelation,
  DISPATCH_IMAGE_CORRELATION_FIELDS, readDispatchImageControlPin, type DispatchImageCorrelation, type DispatchRowData } from '@canlang/work/kernel/tables';
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
  driveDispatchIntent, stageCheckedDeliveryProgress,
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
  /** Once pinned, read only this exact original; ambiguity must never remint it. */
  readonly originalIntentId?: string;
}): Promise<RetainedImagesDispatchLookup> {
  const requested = readDispatchImageCorrelation(input.correlation as unknown as Readonly<Record<string, unknown>>);
  if (requested === null) return { status: 'invalid' };
  const pinnedRow = input.originalIntentId === undefined ? null : await input.store.load(WORK_DISPATCH_MODEL, input.originalIntentId as RecordId);
  const rows = input.originalIntentId === undefined ? await input.store.query({ model: WORK_DISPATCH_MODEL, authority: 'owner',
    where: { op: 'and', args: [
      { op: 'eq', field: 'source', value: 'std.ImagesV1.submit' },
      ...DISPATCH_IMAGE_CORRELATION_FIELDS.map(field => ({ op: 'eq' as const, field, value: requested[field] })),
    ] }, order: [{ field: 'id', direction: 'asc' }], limit: 2 }) : pinnedRow === null ? [] : [pinnedRow];
  if (rows.length === 0) return { status: 'absent' };
  if (rows.length > 1) return { status: 'ambiguous' };
  const row = rows[0]!;
  try {
    const dispatch = readDispatchRow(row);
    if ((input.originalIntentId !== undefined && row.id !== input.originalIntentId) || row.id !== dispatch.intentId || dispatch.source !== 'std.ImagesV1.submit' ||
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

type ResolvedImagesOriginal = Extract<RetainedImagesDispatchLookup, { status: 'resolved' }>;
type ImagesControlAdmission = Pick<BoundMailDriveOptions, 'fence' | 'evaluateGuard' | 'readStateSnapshot'>;
interface ImagesControlObservation {
  readonly original: ResolvedImagesOriginal;
  readonly correlation: DispatchImageCorrelation;
  readonly receipt: AssociatedReceipt;
  readonly admission: ImagesControlAdmission;
  readonly progress?: ImageRunWire;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly stopPending?: boolean;
}
function isImagesControl(intent: OutboxIntent): boolean {
  return intent.target === 'std.ImagesV1.cancel' || intent.target === 'std.ImagesV1.reconcile';
}

/** A control needs a live authoritative locator, not merely an old retained receipt. */
async function readCurrentImagesAssociation(original: ResolvedImagesOriginal, receipt: AssociatedReceipt,
  ctx: SystemCommandContext): Promise<StoredRow> {
  const rows = await ctx.query({ model: RECEIPT_ASSOCIATION_MODEL as ModelName, authority: 'owner',
    where: { op: 'eq', field: 'deliveryId', value: original.retained.intent.intentId },
    order: [{ field: 'id', direction: 'asc' }], limit: 2 });
  if (rows.length !== 1) throw new Error('Images control needs one current original association.');
  const row = rows[0]!;
  const association = readAssociationRow(row);
  if (row.archivedAt !== null || association.source !== original.retained.intent.target ||
      association.deliveryId !== receipt.deliveryId || association.revision !== receipt.revision ||
      typeof row.data['recordModel'] !== 'string') throw new Error('Images original association is stale or malformed.');
  const owner = await ctx.load(row.data['recordModel'] as ModelName, association.locator.recordId as RecordId);
  if (owner === null || owner.archivedAt !== null) throw new Error('Images original association owner is absent.');
  const value = decodeValue(`delivery(${association.source})`, owner.data[association.locator.field]);
  if (!isDeliveryRef(value) || value.id !== receipt.deliveryId || value.operation !== association.source) {
    throw new Error('Images original association no longer names this attempt.');
  }
  return row;
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
    progressCommitted?: boolean; retainedEvidence?: DispatchReconcileEvidence; control?: ImagesControlObservation }>();
  const record: SystemCommandDef = {
    name: originalRecord.name,
    async stage(args, ctx) {
      const staged = await originalRecord.stage(args, ctx);
      const completion = completions.get(`${String(args['intentId'])}\0${String(args['claimId'])}`);
      const outcome = args['outcome'];
      if (completion === undefined || typeof outcome !== 'object' || outcome === null) return staged;
      if (completion.control !== undefined) {
        const extra = await stageImagesControl(completion.intent, completion.control, ctx, (await options.store.readRevision()) + 1);
        return mergeStaging(staged, extra);
      }
      if (!staged.outboxAck?.includes(completion.intent.intentId)) return staged;
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
  const pinAdmissions = new Map<string, { intent: OutboxIntent; admission: ImagesControlAdmission }>();
  const pinOriginal = options.workCommands.find(command => command.name === 'work.dispatch.pin-image-control') as SystemCommandDef | undefined;
  const stopOriginal = options.workCommands.find(command => command.name === 'work.dispatch.stop-pending') as SystemCommandDef | undefined;
  if (options.profile === 'images' && (typeof pinOriginal?.stage !== 'function' || typeof stopOriginal?.stage !== 'function')) {
    throw new Error('Images controls need the defining Work pin and pending-stop stages.');
  }
  const pinCommand: SystemCommandDef = { name: 'work.dispatch.pin-image-control', async stage(args, ctx) {
    const admitted = pinAdmissions.get(`${String(args['intentId'])}\0${String(args['claimId'])}`);
    if (admitted === undefined) throw new Error('Images control pin lost its current cleanup admission.');
    await qualifyImagesControl(admitted.intent, admitted.admission, ctx, String(args['originalIntentId']));
    return pinOriginal!.stage(args, ctx);
  } };
  const registry = producers.createSystemRegistry(assembleDispatchCommands({
    l3Commands: producers.l3Commands,
    workCommands: [...options.workCommands.map(command => command.name === claim.name ? claim
      : command.name === record.name ? record
      : options.profile === 'images' && command.name === pinCommand.name ? pinCommand : command), ...(!rich ? [] : [progressCommand])],
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
  const mergeStaging = (before: SystemStaging, after: SystemStaging): SystemStaging => ({ ...before,
    writes: [...before.writes ?? [], ...after.writes ?? []],
    schedules: [...before.schedules ?? [], ...after.schedules ?? []],
    outboxAck: [...new Set([...before.outboxAck ?? [], ...after.outboxAck ?? []])] });
  const qualifyImagesControl = async (control: OutboxIntent, admission: ImagesControlAdmission,
    ctx: SystemCommandContext, pinnedOriginal?: string): Promise<ImagesControlObservation> => {
    if (options.profile !== 'images' || !isImagesControl(control) || admission.fence.owner === '') {
      throw new Error('Images control needs its actual cleanup owner fence.');
    }
    const revision = await store.readRevision();
    const guard = control.dispatchGuard ?? null;
    if (guard !== null && admission.evaluateGuard(guard, control.arguments,
        await admission.readStateSnapshot(control)) !== true) throw new Error('Images cleanup guard no longer holds.');
    if (await admission.fence.revalidateAuthority() !== true) throw new Error('Images cleanup authority was revoked.');
    const correlation = options.adapter.controlCorrelation(control, admission.fence.owner);
    const controlRow = await ctx.load(WORK_DISPATCH_MODEL, control.intentId as RecordId);
    if (correlation === null || controlRow === null || controlRow.archivedAt !== null) {
      throw new Error('Images control lost its checked durable correlation.');
    }
    const controlData = readDispatchRow(controlRow);
    if (controlData.intentId !== control.intentId || controlData.source !== control.target ||
        controlData.operationId !== control.operationId || controlData.occurrenceIndex !== control.occurrenceIndex ||
        deriveOutboxId(control.operationId, control.target, control.occurrenceIndex) !== control.intentId ||
        typeof controlRow.createdBy !== 'string' || controlRow.createdBy === '' ||
        !Number.isSafeInteger(controlRow.created) || controlRow.created < 0 ||
        DISPATCH_IMAGE_CORRELATION_FIELDS.some(field => controlData[field] !== correlation[field])) {
      throw new Error('Images control durable correlation disagrees with its admitted request.');
    }
    const pin = readDispatchImageControlPin(controlData);
    if (pin !== null && pin.observationStartedAtMs !== controlRow.created) throw new Error('Images control pin lost its original creation time.');
    if (pinnedOriginal !== undefined && pin !== null && pin.originalIntentId !== pinnedOriginal) {
      throw new Error('Images control original pin changed.');
    }
    const original = await lookupRetainedImagesDispatch({ store, correlation,
      ...(pin === null ? {} : { originalIntentId: pin.originalIntentId }) });
    if (original.status !== 'resolved' || !options.adapter.available(original.retained.intent)) {
      throw new Error(`Images control original is ${original.status}.`);
    }
    if (pinnedOriginal !== undefined && original.retained.intent.intentId !== pinnedOriginal) {
      throw new Error('Images control selected original changed before pinning.');
    }
    const context = options.adapter.resultContext(original.retained.intent);
    if (context === null) throw new Error('Images control lost the original request declaration.');
    resultContexts.set(original.retained.intent.intentId, context);
    const receipt = await readRetainedImageGenerationReceipt({ intent: original.retained.intent, context }, ctx);
    if (receipt === null) throw new Error('Images control original receipt is absent.');
    await readCurrentImagesAssociation(original, receipt, ctx);
    if (await admission.fence.revalidateAuthority() !== true) throw new Error('Images cleanup authority was revoked.');
    if (await store.readRevision() !== revision) throw new Error('Images cleanup admission changed.');
    return { original, correlation, receipt, admission };
  };
  const sameImageReceipt = (before: AssociatedReceipt, after: AssociatedReceipt, context: ReceiptResultContext) =>
    before.revision === after.revision && before.status === after.status &&
    before.error?.code === after.error?.code && before.error?.message === after.error?.message &&
    (before.result === null ? after.result === null : after.result !== null &&
      sameRetainedEvidence({ kind: 'delivered', result: before.result }, { kind: 'delivered', result: after.result }, context, 'images'));
  const stageImagesControl = async (control: OutboxIntent, observed: ImagesControlObservation,
    ctx: SystemCommandContext, revision: number): Promise<SystemStaging> => {
    const current = await qualifyImagesControl(control, observed.admission, ctx, observed.original.retained.intent.intentId);
    const original = current.original.retained.intent;
    const originalContext = requireResultContext(original.intentId);
    if (!sameImageReceipt(observed.receipt, current.receipt, originalContext)) {
      throw new Error('Original Images receipt changed before the control join.');
    }
    let staged: SystemStaging = {};
    let progress = observed.progress;
    if (observed.stopPending === true) {
      const stopped = await stopOriginal!.stage({ intentId: original.intentId, correlation: observed.correlation, revision }, ctx);
      const answer = stopped.result as { stopped?: boolean; reason?: string };
      if (answer.stopped !== true && answer.reason !== 'already-stopped') throw new Error('Original Images attempt crossed the pending-stop boundary.');
      staged = stopped;
      if (answer.stopped === true) {
        const row = await readCurrentImagesAssociation(current.original, current.receipt, ctx);
        const association = readAssociationRow(row);
        staged = mergeStaging(staged, { writes: [{ kind: 'update', model: RECEIPT_ASSOCIATION_MODEL as ModelName,
          id: row.id, expectedVersion: row.version, row: withAssociationRowData(row, {
            recordModel: row.data['recordModel'] as string, recordId: association.locator.recordId,
            field: association.locator.field, deliveryId: association.deliveryId, source: association.source, revision,
          }, { actor: ctx.actor, nowMs: ctx.now }) }] });
        if (progressed !== undefined) staged = mergeStaging(staged,
          await stageCheckedDeliveryProgress(progressed, original, observed.admission.fence.owner, ctx));
      }
      progress = { source: observed.correlation.requestSource, revision: observed.correlation.requestRevision,
        sequence: '0', state: 'cancelled', outputs: [], charged_jobs: null, detail: 'Stopped before provider transport.' };
    } else if (progress !== undefined && !['succeeded', 'failed', 'skipped'].includes(current.receipt.status)) {
      staged = mergeStaging(staged, await stageImageGenerationProgress({ intent: original, context: originalContext,
        revision, progress, ...(progressed === undefined ? {} : { progressed: { producer: progressed, owner: observed.admission.fence.owner } }) }, ctx));
    }
    if (progress !== undefined) staged = mergeStaging(staged, await stageImageGenerationProgress({ intent: control,
      context: requireResultContext(control.intentId), revision, progress }, ctx));
    else if (observed.failure !== undefined) staged = mergeStaging(staged, await stageImageGenerationProgress({ intent: control,
      context: requireResultContext(control.intentId), revision, outcome: { kind: 'failed', error: observed.failure } }, ctx));
    return staged;
  };
  const observeImagesControl = async (control: OutboxIntent, admission: ImagesControlAdmission,
    ctx: SystemCommandContext, recovering: boolean): Promise<{ observation: ImagesControlObservation; answer: DispatchProviderOutcome }> => {
    const observed = await qualifyImagesControl(control, admission, ctx);
    const original = observed.original.retained.intent;
    const definitive = await readRetainedImageGenerationEvidence({ intent: original, context: requireResultContext(original.intentId) }, ctx);
    if (definitive?.kind === 'delivered') return { observation: { ...observed, progress: definitive.result as ImageRunWire }, answer: definitive };
    if (definitive?.kind === 'failed') return { observation: { ...observed, failure: { code: definitive.code, message: definitive.message } },
      answer: { kind: 'failed', cause: { kind: 'permanent', code: definitive.code, message: definitive.message } } };
    if (observed.receipt.status === 'skipped' && observed.receipt.result === null ||
        control.target === 'std.ImagesV1.cancel' && observed.receipt.status === 'pending' && observed.receipt.result === null) {
      const progress: ImageRunWire = { source: observed.correlation.requestSource, revision: observed.correlation.requestRevision,
        sequence: '0', state: 'cancelled', outputs: [], charged_jobs: null, detail: 'Stopped before provider transport.' };
      return { observation: { ...observed, stopPending: true, progress }, answer: { kind: 'delivered', result: progress } };
    }
    const row = await ctx.load(WORK_DISPATCH_MODEL, control.intentId as RecordId);
    if (row === null) throw new Error('Images control lost its retained observation pin.');
    const pin = readDispatchImageControlPin(readDispatchRow(row));
    if (pin === null || pin.originalIntentId !== original.intentId) throw new Error('Images control observation needs its immutable original pin.');
    let progress: ImageRunWire | undefined;
    const answer = await (options as BoundImagesDispatcherOptions).adapter.observeControl(control, original, {
      stagedAtMs: observed.original.row.created,
      observation: { startedAtMs: pin.observationStartedAtMs, deadlineMs: pin.observationDeadlineMs }, recovering,
      originalScope: { app: observed.correlation.requestApp, owner: observed.correlation.requestOwner,
        principal: observed.original.principal },
      ...(observed.receipt.result === null ? {} : { sequence: (observed.receipt.result as unknown as ImageRunWire).sequence }),
      onQueued: async () => { throw new Error('Images control cannot submit a replacement.'); },
      onProgress: async value => { progress = value; },
    });
    return { observation: { ...observed, ...(progress === undefined ? {} : { progress }) }, answer };
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
            if (options.profile === 'images' && isImagesControl(selected)) {
              const admission = { fence: input.fence, evaluateGuard: input.evaluateGuard, readStateSnapshot: input.readStateSnapshot };
              const original = await qualifyImagesControl(selected, admission, scope);
              const row = await store.load(WORK_DISPATCH_MODEL, selected.intentId as RecordId);
              if (row === null) throw new Error('Images control lost its held dispatch.');
              const saved = readDispatchImageControlPin(readDispatchRow(row));
              const observation = saved === null ? options.adapter.controlObservation(selected, row.created)
                : { startedAtMs: saved.observationStartedAtMs, deadlineMs: saved.observationDeadlineMs };
              if (observation === null || observation === undefined) throw new Error('Images control observation policy is unavailable.');
              pinAdmissions.set(heldKey, { intent: selected, admission });
              await registry.run(pinCommand.name, { intentId: selected.intentId, claimId: held.claimId,
                originalIntentId: original.original.retained.intent.intentId, correlation: original.correlation, observation },
                { actor: input.actor, now: input.nowMs(), operation: input.operation, operationId: `${held.claimId}:image-control-pin` }, { store });
              const controlled = await observeImagesControl(selected, admission, scope, saved !== null);
              completions.set(heldKey, { intent: selected, outcome: controlled.answer, owner: input.fence.owner, control: controlled.observation });
              return controlled.answer;
            }
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
        for (const key of heldKeys) { completions.delete(key); progressOwners.delete(key); pinAdmissions.delete(key); }
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
      const controlObservations = new Map<string, ImagesControlObservation>();
      const retainedContext = { actor: input.actor, now: input.nowMs(), operation: input.operation,
        load: store.load.bind(store), query: store.query.bind(store) };
      // The existing recovery planner selects its bounded page by intent ID.
      // Fetch that same page, rather than D1's default creation-time order.
      const rows = await store.query({ ...dispatchByStateQuery('uncertain'),
        order: [{ field: 'id', direction: 'asc' }], limit: input.limit });
      // One bounded page must not observe and then overwrite the same original
      // twice. Its pinned cleanup delivery owns this sweep's observation join.
      const controlledOriginals = new Set(rows.flatMap(row => {
        const data = readDispatchRow(row);
        const intent = pending.get(data.intentId);
        const pin = intent !== undefined && isImagesControl(intent) ? readDispatchImageControlPin(data) : null;
        return pin === null ? [] : [pin.originalIntentId];
      }));
      for (const row of rows) {
        const dispatch = readDispatchExecutionRow(row);
        if (dispatch.state !== 'uncertain') continue;
        const intent = pending.get(dispatch.intentId);
        if (intent === undefined || !options.adapter.available(intent)) continue;
        if (options.profile === 'images' && controlledOriginals.has(intent.intentId)) continue;
        if (options.profile === 'images') await admitImagesRecovery(intent);
        if (options.profile === 'images' && isImagesControl(intent)) {
          const admission = input.admission!;
          const checked = await qualifyImagesControl(intent, admission, retainedContext);
          const pin = readDispatchImageControlPin(readDispatchRow(row));
          if (pin === null || pin.originalIntentId !== checked.original.retained.intent.intentId) continue;
          const definitive = await readRetainedImageGenerationEvidence({ intent, context: requireResultContext(intent.intentId) }, retainedContext);
          if (definitive !== null) {
            retainedEvidence.add(intent.intentId); evidence.set(intent.intentId, definitive);
          } else {
            const controlled = await observeImagesControl(intent, admission, retainedContext, true);
            if (controlled.answer.kind === 'delivered') {
              controlObservations.set(intent.intentId, controlled.observation);
              evidence.set(intent.intentId, { kind: 'delivered', result: controlled.answer.result });
            } else if (controlled.observation.failure !== undefined) {
              controlObservations.set(intent.intentId, controlled.observation);
              evidence.set(intent.intentId, { kind: 'failed', ...controlled.observation.failure });
            }
          }
          continue;
        }
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
          if (isImagesControl(intent)) {
            await qualifyImagesControl(intent, input.admission!, retainedContext);
          }
        } }),
        stageReconciledReceipt: async ({ intentId, evidence: answer, revision, context }) => {
          const intent = pending.get(intentId);
          if (intent === undefined || !options.adapter.available(intent)) {
            throw new Error('Reconciled mail lost its installed original intent.');
          }
          const admitted = options.profile === 'images' ? await admitImagesRecovery(intent, revision - 1) : undefined;
          const control = controlObservations.get(intentId);
          if (control !== undefined) return stageImagesControl(intent, control, context, revision);
          if (options.profile === 'images' && isImagesControl(intent)) {
            await qualifyImagesControl(intent, input.admission!, context);
          }
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
