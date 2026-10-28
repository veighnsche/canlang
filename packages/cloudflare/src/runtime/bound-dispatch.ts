/** Installed provider dispatch over the existing Work lifecycle and State join. */
import type { ClaimId, OutboxId, OutboxIntent, ReceiptResultContext, StoragePort, RecordId, ModelName, AssociatedReceipt, StoredRow, RetainedOutboxIntent, FileReferenceStoragePort, FrameworkOpaquePayloadOrigin, FrameworkOpaqueDeliveryContext } from '@canlang/contracts';
import type { DispatchClaimGuard, DispatchClaimGuardInput } from '@canlang/work/kernel/commands';
import { createReceiptJoinPort, RECEIPT_MODEL, RECEIPT_ASSOCIATION_MODEL, readAssociationRow, withAssociationRowData, readReceiptRow, withReceiptRowData, associationRowId } from '@canlang/state/receipt/tables';
import { readFinalizedFileObservation } from '@canlang/files/finalize';
import { prepareFrameworkFilePayloadOrigin, type FrameworkFilePayloadOriginInput } from '@canlang/state/storage';
import { stableStringify } from '@canlang/state/invocation';
import { decodeValue, equalValue, isDeliveryRef } from '@canlang/values';
import type { SystemCommandContext, SystemStaging } from '@canlang/state';
import { enrollSystemCommandCommitCheck, systemCommandStageRevision } from '@canlang/state';
import type { SystemCommandDef } from '@canlang/state/ports/system';
import { dispatchByStateQuery, WORK_DISPATCH_MODEL, readDispatchRow, readDispatchImageCorrelation,
  DISPATCH_IMAGE_CORRELATION_FIELDS, readDispatchImageControlPin, readDispatchMailRecipientPin, dispatchGenerationTargetProfile,
  type DispatchImageCorrelation, type DispatchRowData, type DispatchGenerationTargetProfile } from '@canlang/work/kernel/tables';
import { readRetainedSendInputs } from '@canlang/work/kernel/dispatch-staging';
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
  driveDispatchIntent, driveDispatchIntentWithPreclaim, stageCheckedDeliveryProgress,
  checkRecordResult,
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
  DispatchSystemRegistry,
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
async function lookupRetainedGenerationDispatch(input: {
  readonly store: StoragePort;
  readonly correlation: DispatchImageCorrelation;
  readonly originalSource: 'std.ImagesV1.submit' | 'std.TextGenerationV1.generate';
  /** Once pinned, read only this exact original; ambiguity must never remint it. */
  readonly originalIntentId?: string;
}): Promise<RetainedImagesDispatchLookup> {
  const requested = readDispatchImageCorrelation(input.correlation as unknown as Readonly<Record<string, unknown>>);
  if (requested === null) return { status: 'invalid' };
  const fetchDispatchRows = async () => {
    if (input.originalIntentId !== undefined) {
      const pinnedRow = await input.store.load(WORK_DISPATCH_MODEL, input.originalIntentId as RecordId);
      return pinnedRow === null ? [] : [pinnedRow];
    }
    return input.store.query({ model: WORK_DISPATCH_MODEL, authority: 'owner',
      where: { op: 'and', args: [
        { op: 'eq', field: 'source', value: input.originalSource },
        ...DISPATCH_IMAGE_CORRELATION_FIELDS.map(field => ({ op: 'eq' as const, field, value: requested[field] })),
      ] }, order: [{ field: 'id', direction: 'asc' }], limit: 2 });
  };
  const checkDispatchIdentity = (row: StoredRow) => {
    const dispatch = readDispatchRow(row);
    if ((input.originalIntentId !== undefined && row.id !== input.originalIntentId) || row.id !== dispatch.intentId || dispatch.source !== input.originalSource ||
        DISPATCH_IMAGE_CORRELATION_FIELDS.some(field => dispatch[field] !== requested[field]) ||
        row.archivedAt !== null || typeof row.createdBy !== 'string' || row.createdBy === '' ||
        !Number.isSafeInteger(row.created) || row.created < 0) return null;
    return dispatch;
  };
  const checkIntentIdentity = (
    dispatch: DispatchRowData, intent: OutboxIntent,
  ): boolean => {
    if (intent.intentId !== dispatch.intentId || intent.target !== dispatch.source ||
        intent.operationId !== dispatch.operationId || intent.occurrenceIndex !== dispatch.occurrenceIndex ||
        deriveOutboxId(intent.operationId, intent.target, intent.occurrenceIndex) !== intent.intentId) return false;
    return true;
  };
  const checkRetainedIntent = async (dispatch: DispatchRowData) => {
    const retained = await input.store.outboxGet(dispatch.intentId);
    if (retained === null || !['pending', 'dispatched', 'skipped'].includes(retained.status)) return null;
    const intent = retained.intent;
    if (!checkIntentIdentity(dispatch, intent)) return null;
    const carrier = intent.arguments;
    const args = carrier['arguments'];
    if (Object.keys(carrier).length !== 3 || carrier['binding'] !== requested.requestBinding ||
        carrier['from'] !== requested.requestFrom || typeof args !== 'object' || args === null || Array.isArray(args) ||
        Object.keys(args).length !== 1 || !Object.hasOwn(args, 'value')) return null;
    const value = (args as Record<string, unknown>)['value'];
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
        (value as Record<string, unknown>)['source'] !== requested.requestSource ||
        (value as Record<string, unknown>)['revision'] !== requested.requestRevision) return null;
    return retained;
  };
  const rows = await fetchDispatchRows();
  if (rows.length === 0) return { status: 'absent' };
  if (rows.length > 1) return { status: 'ambiguous' };
  const row = rows[0]!;
  try {
    const dispatch = checkDispatchIdentity(row);
    if (dispatch === null) return { status: 'invalid' };
    const retained = await checkRetainedIntent(dispatch);
    if (retained === null) return { status: 'invalid' };
    return { status: 'resolved', row, dispatch, retained, principal: row.createdBy };
  } catch { return { status: 'invalid' }; }
}

/** Compatible Images entry point over the same closed generation lookup. */
export function lookupRetainedImagesDispatch(input: {
  readonly store: StoragePort;
  readonly correlation: DispatchImageCorrelation;
  readonly originalIntentId?: string;
}): Promise<RetainedImagesDispatchLookup> {
  return lookupRetainedGenerationDispatch({ ...input, originalSource: 'std.ImagesV1.submit' });
}

export function lookupRetainedTextGenerationDispatch(input: {
  readonly store: StoragePort;
  readonly correlation: DispatchImageCorrelation;
  readonly originalIntentId?: string;
}): Promise<RetainedImagesDispatchLookup> {
  return lookupRetainedGenerationDispatch({ ...input, originalSource: 'std.TextGenerationV1.generate' });
}

export interface BoundMailDispatcherOptions {
  readonly store: StoragePort;
  readonly adapter: BoundMailAdapter;
  readonly workCommands: readonly DispatchWorkerCommand[];
  readonly stageCommands: readonly DispatchWorkerCommand[];
  /** The defining Work factory; availability must precede claim writes. */
  readonly createClaimCommand: (
    available: (intentId: OutboxId, target: string) => boolean,
    guard?: DispatchClaimGuard,
    claimIdAllocator?: () => ClaimId,
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
  /** Generation controls and Images observation/acknowledgement use the actual current host fence. */
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
  /** Original registered physical State port, even when store wraps commit. */
  readonly fileOriginStore?: FileReferenceStoragePort;
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
class GenerationControlCheckpointMoved extends Error {
  constructor() { super('Generation cleanup admission changed.'); }
}
type TextControlAdapter = BoundTextGenerationAdapter & Required<Pick<BoundTextGenerationAdapter,
  'controlCorrelation' | 'controlObservation' | 'observeControl'>>;
function hasTextControlEntries(adapter: BoundTextGenerationAdapter): adapter is TextControlAdapter {
  return typeof adapter.controlCorrelation === 'function' && typeof adapter.controlObservation === 'function' &&
    typeof adapter.observeControl === 'function';
}

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
  if (['std.ImagesV1.inspect', 'std.ImagesV1.validate'].includes(context.source)) {
    return actual !== null && stableStringify(expected) === stableStringify(actual);
  }
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

type ResolvedGenerationOriginal = Extract<RetainedImagesDispatchLookup, { status: 'resolved' }>;
type GenerationControlAdmission = Pick<BoundMailDriveOptions, 'fence' | 'evaluateGuard' | 'readStateSnapshot'>;
interface GenerationControlObservation {
  readonly original: ResolvedGenerationOriginal;
  readonly correlation: DispatchImageCorrelation;
  readonly receipt: AssociatedReceipt;
  readonly originalContext: ReceiptResultContext;
  readonly admission: GenerationControlAdmission;
  readonly progress?: RichRunWire;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly stopPending?: boolean;
}
function isWorkflowReview(intent: OutboxIntent): boolean {
  return ['std.ImagesV1.inspect', 'std.ImagesV1.validate'].includes(intent.target);
}
function isGenerationControl(intent: OutboxIntent): boolean {
  return dispatchGenerationTargetProfile(intent.target)?.role === 'control';
}

/** A control needs a live authoritative locator, not merely an old retained receipt. */
async function readCurrentGenerationAssociation(original: ResolvedGenerationOriginal, receipt: AssociatedReceipt,
  ctx: SystemCommandContext): Promise<StoredRow> {
  const rows = await ctx.query({ model: RECEIPT_ASSOCIATION_MODEL as ModelName, authority: 'owner',
    where: { op: 'eq', field: 'deliveryId', value: original.retained.intent.intentId },
    order: [{ field: 'id', direction: 'asc' }], limit: 2 });
  if (rows.length !== 1) throw new Error('Generation control needs one current original association.');
  const row = rows[0]!;
  const association = readAssociationRow(row);
  if (row.archivedAt !== null || association.source !== original.retained.intent.target ||
      association.deliveryId !== receipt.deliveryId || association.revision !== receipt.revision ||
      typeof row.data['recordModel'] !== 'string') throw new Error('Generation original association is stale or malformed.');
  const owner = await ctx.load(row.data['recordModel'] as ModelName, association.locator.recordId as RecordId);
  if (owner === null || owner.archivedAt !== null) throw new Error('Generation original association owner is absent.');
  const value = decodeValue(`delivery(${association.source})`, owner.data[association.locator.field]);
  if (!isDeliveryRef(value) || value.id !== receipt.deliveryId || value.operation !== association.source) {
    throw new Error('Generation original association no longer names this attempt.');
  }
  return row;
}

const resolveDispatcherProfile = (options: InstalledDispatcherOptions) => {
  const rich = options.profile === 'text' || options.profile === 'images';
  const textControls = options.profile === 'text' && hasTextControlEntries(options.adapter) ? options.adapter : null;
  const controlAdapter = options.profile === 'images' ? options.adapter : textControls;
  const typed = options.profile !== 'mail';
  const progressed = options.profile === 'text' || options.profile === 'images' ? options.progressed : undefined;
  const readRetainedReceipt = options.profile === 'images'
    ? readRetainedImageGenerationReceipt : readRetainedTextGenerationReceipt;
  const readRetainedEvidence = options.profile === 'images'
    ? readRetainedImageGenerationEvidence : readRetainedTextGenerationEvidence;
  return { rich, textControls, controlAdapter, typed, progressed, readRetainedReceipt, readRetainedEvidence };
};

async function createInstalledDispatcher(
  options: InstalledDispatcherOptions,
): Promise<BoundMailDispatcher> {
  const { rich, textControls, controlAdapter, typed, progressed, readRetainedReceipt: readRunReceipt, readRetainedEvidence: readRunEvidence } =
    resolveDispatcherProfile(options);
  const usesRichProgress = (intent: OutboxIntent) => rich && !isWorkflowReview(intent);
  const readRetainedReceipt = async (input: { intent: OutboxIntent; context: ReceiptResultContext }, ctx: SystemCommandContext) => {
    if (!isWorkflowReview(input.intent)) return readRunReceipt(input, ctx);
    if (input.context.source !== input.intent.target) throw new Error('Workflow receipt changed its original source.');
    const retained = await options.store.outboxGet(input.intent.intentId);
    const dispatch = await ctx.load(WORK_DISPATCH_MODEL, input.intent.intentId as RecordId);
    if (retained === null || dispatch === null || stableStringify(retained.intent) !== stableStringify(input.intent)) {
      throw new Error('Workflow receipt lost its exact retained SEND.');
    }
    readRetainedSendInputs(dispatch, input.intent);
    const row = await ctx.load(RECEIPT_MODEL as ModelName, input.intent.intentId as RecordId);
    if (row === null) return null;
    const receipt = readReceiptRow(row, input.context).receipt;
    if (receipt.deliveryId !== input.intent.intentId) throw new Error('Workflow receipt changed its delivery identity.');
    return receipt;
  };
  const readRetainedEvidence = async (input: { intent: OutboxIntent; context: ReceiptResultContext }, ctx: SystemCommandContext): Promise<DispatchReconcileEvidence | null> => {
    if (!isWorkflowReview(input.intent)) return readRunEvidence(input, ctx);
    const receipt = await readRetainedReceipt(input, ctx);
    if (receipt?.status === 'succeeded') return { kind: 'delivered', result: receipt.result };
    if (receipt?.status === 'failed' && receipt.error !== null) return { kind: 'failed', ...receipt.error };
    return null;
  };
  const progressFiles = new Map<string, { readonly json: string;
    readonly files: FrameworkFilePayloadOriginInput['files']; readonly current: () => boolean | Promise<boolean>; consumed: boolean }>();
  const stageRichProgress = async (input: { intent: OutboxIntent; context: ReceiptResultContext; revision: number;
    progressed?: { producer: CheckedDeliveryProgressProducer; owner: string } } & (
      { progress: RichRunWire; outcome?: never } |
      { outcome: { kind: 'failed'; error: { code: string; message: string } }; progress?: never }),
    ctx: SystemCommandContext, files: FrameworkFilePayloadOriginInput['files'] = []): Promise<SystemStaging> => {
    const staged = options.profile === 'images'
      ? await stageImageGenerationProgress({ ...input,
          ...(input.progress === undefined ? {} : { progress: input.progress as ImageRunWire }) } as Parameters<typeof stageImageGenerationProgress>[0], ctx)
      : await stageTextGenerationProgress({ ...input,
          ...(input.progress === undefined ? {} : { progress: input.progress as TextRunWire }) } as Parameters<typeof stageTextGenerationProgress>[0], ctx);
    if (options.profile !== 'images') return staged;
    const row = await ctx.load(RECEIPT_MODEL as ModelName, input.intent.intentId as RecordId);
    if (row === null) throw new Error('Images progress lost its original receipt lifetime.');
    const prior = readReceiptRow(row, input.context), binding = prior.filePayloadOrigin;
    const outputCount = input.progress === undefined ? 0 : (input.progress as ImageRunWire).outputs.length;
    // File-free legacy attempts retain their existing behavior. New physical
    // outputs never enter an unbound lifetime or borrow a fabricated header.
    if (binding === undefined) {
      if (outputCount !== 0 || files.length !== 0) throw new Error('Images outputs require the original bound receipt lifetime.');
      return staged;
    }
    const physical = options.fileOriginStore, origin = binding.origin;
    const expectedRevision = systemCommandStageRevision(ctx);
    const checkStateRequestFence = async () => {
      if (physical === undefined || input.revision !== expectedRevision + 1 ||
          await physical.readRevision() !== expectedRevision ||
          stableStringify(await physical.load(RECEIPT_MODEL as ModelName, row.id)) !== stableStringify(row) ||
          origin.kind !== 'delivery-result' || origin.declaration.kind !== 'generation' ||
          origin.intent.intentId !== input.intent.intentId || origin.intent.operation !== input.intent.operation ||
          origin.intent.operationId !== input.intent.operationId || origin.intent.target !== input.intent.target ||
          origin.intent.occurrenceIndex !== input.intent.occurrenceIndex ||
          input.intent.arguments['binding'] !== origin.request.binding || input.intent.arguments['from'] !== origin.request.from ||
          origin.declaration.request.source !== input.context.request?.source ||
          origin.declaration.request.revision !== input.context.request?.revision) {
        throw new Error('Images progress requires its same original State/request/source fence.');
      }
      return { origin: origin as FencedImagesOrigin, physical };
    };
    type FencedImagesOrigin = Extract<FrameworkOpaquePayloadOrigin, { kind: 'delivery-result' }> & {
      declaration: Extract<FrameworkOpaqueDeliveryContext, { kind: 'generation' }>;
    };
    type ImagesProgressFence = Awaited<ReturnType<typeof checkStateRequestFence>>;
    const checkWorkCorrelation = async (fence: ImagesProgressFence): Promise<void> => {
      const dispatchRow = await ctx.load(WORK_DISPATCH_MODEL, input.intent.intentId as RecordId);
      if (dispatchRow === null) throw new Error('Images progress lost its original Work request.');
      const dispatch = readDispatchRow(dispatchRow), correlation = readDispatchImageCorrelation(dispatch);
      const origin = fence.origin;
      const wanted = { requestSource: origin.declaration.request.source, requestRevision: origin.declaration.request.revision,
        requestBinding: origin.request.binding, requestFrom: origin.request.from,
        requestApp: binding.scope.app, requestOwner: binding.scope.owner };
      if (dispatch.intentId !== input.intent.intentId || dispatch.operationId !== input.intent.operationId ||
          dispatch.source !== input.intent.target || dispatch.occurrenceIndex !== input.intent.occurrenceIndex ||
          dispatchRow.createdBy !== row.createdBy || stableStringify(correlation) !== stableStringify(wanted)) {
        throw new Error('Images progress changed its six-field original correlation.');
      }
    };
    const checkAssociation = async (fence: ImagesProgressFence): Promise<void> => {
      const origin = fence.origin;
      const association = await ctx.load(RECEIPT_ASSOCIATION_MODEL as ModelName,
        associationRowId(origin.association.model, origin.association.recordId, origin.association.field) as RecordId);
      const owner = await ctx.load(origin.association.model, origin.association.recordId);
      if (association === null || owner === null || owner.archivedAt !== null ||
          readAssociationRow(association).deliveryId !== input.intent.intentId) {
        throw new Error('Images progress original association was superseded.');
      }
      const delivery = decodeValue(`delivery(${input.intent.target})`, owner.data[origin.association.field]);
      if (!isDeliveryRef(delivery) || delivery.id !== input.intent.intentId || delivery.operation !== input.intent.target) {
        throw new Error('Images progress original owner no longer names this attempt.');
      }
    };
    const checkProgressFiles = (fence: ImagesProgressFence): void => {
      const origin = fence.origin;
      if (files.length !== outputCount) throw new Error('Images progress needs every genuine typed File position.');
      for (let index = 0; index < files.length; index++) {
        const entry = files[index]!, file = readFinalizedFileObservation(entry.observation);
        if (file === null || stableStringify(entry.path) !== stableStringify(['outputs', index, 'image']) ||
            file.ref !== (input.progress as ImageRunWire).outputs[index]!.image.id ||
            file.receiver.app !== binding.scope.app || file.receiver.team !== binding.scope.owner ||
            file.receiver.owner !== binding.scope.owner || file.receiver.principal !== row.createdBy ||
            file.provenance.kind !== 'request' || file.provenance.deliveryId !== input.intent.intentId ||
            file.provenance.adapter !== origin.request.from) {
          throw new Error('Images output changed its original physical receiver/provenance or typed position.');
        }
      }
    };
    const bindReceiptWrites = async (fence: ImagesProgressFence) => {
      const physical = fence.physical, origin = fence.origin;
      const writes = [];
      for (const write of staged.writes ?? []) {
        if (write.kind !== 'update' || write.model !== RECEIPT_MODEL || write.id !== row.id) {
          writes.push(write); continue;
        }
        const header = await prepareFrameworkFilePayloadOrigin(physical, {
          expectedRevision, inventoryOwner: binding.inventory.owner, declarationSetId: binding.declarationSetId,
          model: RECEIPT_MODEL as ModelName, row: write.row, field: 'result', scope: binding.scope,
          origin, files,
        });
        const receipt = readReceiptRow(write.row, input.context);
        writes.push({ ...write, row: withReceiptRowData(row, { ...receipt.receipt,
          contentRef: receipt.contentRef, resultExpiresAtMs: receipt.resultExpiresAtMs, filePayloadOrigin: header },
          { actor: ctx.actor, nowMs: ctx.now }, input.context) });
      }
      return writes;
    };
    const fence = await checkStateRequestFence();
    await checkWorkCorrelation(fence);
    await checkAssociation(fence);
    if ((staged.writes?.length ?? 0) === 0) return staged;
    checkProgressFiles(fence);
    const writes = await bindReceiptWrites(fence);
    const revalidate = options.adapter.revalidateOutput;
    const fencePhysical = fence.physical;
    enrollSystemCommandCommitCheck(ctx, async () => {
      if (options.adapter.revalidateOutput !== revalidate || await fencePhysical.readRevision() !== expectedRevision ||
          stableStringify(await fencePhysical.load(RECEIPT_MODEL as ModelName, row.id)) !== stableStringify(row)) return false;
      for (const entry of files) {
        if (revalidate === undefined || !await revalidate.call(options.adapter, entry.observation)) return false;
      }
      return options.adapter.revalidateOutput === revalidate && await fencePhysical.readRevision() === expectedRevision;
    });
    return { ...staged, writes };
  };
  const producers = await loadDispatchSystemProducers();
  const pending = new Map<string, OutboxIntent>();
  const resultContexts = new Map<string, ReceiptResultContext>();
  const controlContextUses = new Map<string, number>();
  const retainControlContext = (observed: GenerationControlObservation): string => {
    const id = observed.original.retained.intent.intentId;
    resultContexts.set(id, observed.originalContext);
    controlContextUses.set(id, (controlContextUses.get(id) ?? 0) + 1);
    return id;
  };
  const releaseControlContext = (id: string): void => {
    const uses = controlContextUses.get(id) ?? 0;
    if (uses > 1) controlContextUses.set(id, uses - 1);
    else {
      controlContextUses.delete(id);
      if (!pending.has(id)) resultContexts.delete(id);
    }
  };
  // Structural claim gate only: the pending row must match. Deployment
  // availability (adapter.available) rides the fence port instead —
  // the kernel preflights it after the claim win but before guard
  // evaluation, and the held claim lets the drive terminalize the
  // refusal (failed/terminal receipt + record + ack) instead of
  // leaving the intent pending forever. Refusing here would make
  // the terminal path unreachable: no held claim, no record.
  const claim = options.createClaimCommand((id, target) => {
    const intent = pending.get(id);
    return intent !== undefined && intent.target === target &&
      (!isGenerationControl(intent) || controlAdapter !== null);
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
  const reviewAuthorities = new Map<string, () => boolean | Promise<boolean>>();
  const completions = new Map<string, { intent: OutboxIntent; outcome: DispatchProviderOutcome;
    owner: string;
    progressCommitted?: boolean; retainedEvidence?: DispatchReconcileEvidence; control?: GenerationControlObservation }>();
  const stageControlCompletion = async (
    completion: NonNullable<ReturnType<typeof completions.get>>,
    staged: Awaited<ReturnType<SystemCommandDef['stage']>>, ctx: SystemCommandContext,
  ) => {
    const acknowledging = staged.outboxAck?.includes(completion.intent.intentId) === true;
    if (acknowledging && completion.intent.target.endsWith('.reconcile')) {
      const admission = completion.control!.admission;
      enrollSystemCommandCommitCheck(ctx, () => admission.fence.revalidateAuthority());
    }
    const extra = await stageGenerationControl(completion.intent, completion.control!, ctx,
      (await options.store.readRevision()) + 1, acknowledging);
    return mergeStaging(staged, extra);
  };
  const selectRecordedOutcome = (
    completion: NonNullable<ReturnType<typeof completions.get>>, outcome: Record<string, unknown>,
  ) => {
    if (completion.outcome.kind === 'delivered' && outcome['state'] === 'delivered') {
      return { kind: 'delivered' as const, result: completion.outcome.result };
    }
    if (completion.outcome.kind === 'failed' && outcome['state'] === 'failed' &&
        outcome['retryClass'] === 'terminal' && typeof outcome['errorCode'] === 'string' &&
        typeof outcome['errorMessage'] === 'string') {
      return { kind: 'failed' as const, error: { code: outcome['errorCode'], message: outcome['errorMessage'] } };
    }
    return null;
  };
  const stageCompletionReceipt = async (
    completion: NonNullable<ReturnType<typeof completions.get>>,
    selected: NonNullable<ReturnType<typeof selectRecordedOutcome>>, ctx: SystemCommandContext,
  ) => {
    const revision = (await options.store.readRevision()) + 1;
    if (isWorkflowReview(completion.intent)) {
      await readRetainedReceipt({ intent: completion.intent, context: requireResultContext(completion.intent.intentId) }, ctx);
    }
    const receipt = !usesRichProgress(completion.intent)
      ? await stageReceiptProgress({ intent: completion.intent, outcome: selected, revision,
        ...(typed ? { context: requireResultContext(completion.intent.intentId) } : {}) }, ctx)
      : await stageRichProgress({ intent: completion.intent,
        context: requireResultContext(completion.intent.intentId), revision,
        ...(progressed === undefined ? {} : { progressed: { producer: progressed, owner: completion.owner } }),
        ...(selected.kind === 'delivered' ? { progress: selected.result as RichRunWire } : { outcome: selected }) }, ctx);
    return receipt;
  };
  const record: SystemCommandDef = {
    name: originalRecord.name,
    async stage(args, ctx) {
      const staged = await originalRecord.stage(args, ctx);
      const completion = completions.get(`${String(args['intentId'])}\0${String(args['claimId'])}`);
      const outcome = args['outcome'];
      if (completion === undefined || typeof outcome !== 'object' || outcome === null) return staged;
      const reviewCurrent = reviewAuthorities.get(`${String(args['intentId'])}\0${String(args['claimId'])}`);
      if (isWorkflowReview(completion.intent)) {
        if (reviewCurrent === undefined || !await reviewCurrent()) throw new Error('Workflow review authority changed before completion.');
        enrollSystemCommandCommitCheck(ctx, reviewCurrent);
      }
      if (completion.control !== undefined) {
        return stageControlCompletion(completion, staged, ctx);
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
      const selected = selectRecordedOutcome(completion, outcome as Record<string, unknown>);
      if (selected === null) return staged;
      const receipt = await stageCompletionReceipt(completion, selected, ctx);
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
      const key = `${intent.intentId}\0${held.claimId}`, original = progressFiles.get(key);
      if (options.profile === 'images' && (original === undefined || original.consumed || original.json !== stableStringify(args['progress']))) {
        throw new Error('Images progress requires its actual held private observation execution.');
      }
      if (original !== undefined) {
        original.consumed = true;
        enrollSystemCommandCommitCheck(ctx, original.current);
      }
      return stageRichProgress({ intent, context: requireResultContext(intent.intentId),
        ...(progressed === undefined ? {} : { progressed: { producer: progressed, owner } }),
        progress: args['progress'] as RichRunWire, revision: (await options.store.readRevision()) + 1 }, ctx, original?.files);
    },
  };
  const progressOwners = new Map<string, string>();
  const pinAdmissions = new Map<string, { intent: OutboxIntent; admission: GenerationControlAdmission }>();
  const pinOriginal = options.workCommands.find(command => command.name === 'work.dispatch.pin-image-control') as SystemCommandDef | undefined;
  const stopOriginal = options.workCommands.find(command => command.name === 'work.dispatch.stop-pending') as SystemCommandDef | undefined;
  if (controlAdapter !== null && (typeof pinOriginal?.stage !== 'function' || typeof stopOriginal?.stage !== 'function')) {
    throw new Error('Generation controls need the defining Work pin and pending-stop stages.');
  }
  const pinCommand: SystemCommandDef = { name: 'work.dispatch.pin-image-control', async stage(args, ctx) {
    const admitted = pinAdmissions.get(`${String(args['intentId'])}\0${String(args['claimId'])}`);
    if (admitted === undefined) throw new Error('Generation control pin lost its current cleanup admission.');
    await qualifyGenerationControl(admitted.intent, admitted.admission, ctx, String(args['originalIntentId']));
    return pinOriginal!.stage(args, ctx);
  } };
  const mailAdapter = options.profile === 'mail' ? options.adapter : null;
  const mailPins = new Map<string, { readonly intent: OutboxIntent; readonly current: () => Promise<boolean>; readonly email: string }>();
  const mailPinOriginal = options.workCommands.find(command => command.name === 'work.dispatch.pin-mail-recipient') as SystemCommandDef | undefined;
  const mailPinCommand: SystemCommandDef = { name: 'work.dispatch.pin-mail-recipient', async stage(args, ctx) {
    const admitted = mailPins.get(`${String(args['intentId'])}\0${String(args['claimId'])}`);
    if (admitted === undefined || mailAdapter === null || typeof mailPinOriginal?.stage !== 'function' || !await admitted.current()) {
      throw new Error('Private mail pin requires its current held recipient admission.');
    }
    const recipient = mailAdapter.userRecipient(admitted.intent);
    if (recipient === null || args['mailRecipientUser'] !== recipient.user || args['mailRecipientTeam'] !== recipient.team || args['mailRecipientEmail'] !== admitted.email) {
      throw new Error('Private mail pin differs from its original selected recipient.');
    }
    enrollSystemCommandCommitCheck(ctx, admitted.current);
    return mailPinOriginal.stage(args, ctx);
  } };
  const composedCommands = assembleDispatchCommands({
    l3Commands: producers.l3Commands,
    workCommands: [...options.workCommands.map(command => command.name === claim.name ? claim
      : command.name === record.name ? record
      : controlAdapter !== null && command.name === pinCommand.name ? pinCommand
      : mailAdapter !== null && command.name === mailPinCommand.name ? mailPinCommand : command), ...(!rich ? [] : [progressCommand])],
    stageCommands: options.stageCommands,
  });
  const registryForClaim = (selectedClaim: DispatchWorkerCommand): DispatchSystemRegistry =>
    producers.createSystemRegistry(composedCommands.map(command => command.name === claim.name ? selectedClaim : command));
  const registry = registryForClaim(claim);
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
      if (!pending.has(id) && !controlContextUses.has(id)) resultContexts.delete(id);
    }
  };
  const mergeStaging = (before: SystemStaging, after: SystemStaging): SystemStaging => ({ ...before,
    writes: [...before.writes ?? [], ...after.writes ?? []],
    schedules: [...before.schedules ?? [], ...after.schedules ?? []],
    outboxAck: [...new Set([...before.outboxAck ?? [], ...after.outboxAck ?? []])] });
  const qualifyGenerationControl = async (control: OutboxIntent, admission: GenerationControlAdmission,
    ctx: SystemCommandContext, pinnedOriginal?: string): Promise<GenerationControlObservation> => {
    // Original progress and its Work acknowledgement may commit while this
    // read-only qualification awaits. Retry the complete current authority and
    // correspondence checks; the enclosing system commit keeps its own fence.
    for (let attempt = 0; ; attempt++) {
      try { return await qualifyGenerationControlOnce(control, admission, ctx, pinnedOriginal); }
      catch (error) {
        if (!(error instanceof GenerationControlCheckpointMoved) || attempt === 2) throw error;
      }
    }
  };
  const checkControlDurableCorrelation = (
    control: OutboxIntent, correlation: DispatchImageCorrelation, controlRow: StoredRow,
  ) => {
    const controlData = readDispatchRow(controlRow);
    if (controlData.intentId !== control.intentId || controlData.source !== control.target ||
        controlData.operationId !== control.operationId || controlData.occurrenceIndex !== control.occurrenceIndex ||
        deriveOutboxId(control.operationId, control.target, control.occurrenceIndex) !== control.intentId ||
        typeof controlRow.createdBy !== 'string' || controlRow.createdBy === '' ||
        !Number.isSafeInteger(controlRow.created) || controlRow.created < 0 ||
        DISPATCH_IMAGE_CORRELATION_FIELDS.some(field => controlData[field] !== correlation[field])) {
      throw new Error('Generation control durable correlation disagrees with its admitted request.');
    }
    return controlData;
  };
  type ResolvedGenerationOriginal = Extract<Awaited<ReturnType<typeof lookupRetainedGenerationDispatch>>, { status: 'resolved' }>;
  const resolveControlOriginal = async (
    correlation: DispatchImageCorrelation, pin: ReturnType<typeof readDispatchImageControlPin>,
    originalSource: DispatchGenerationTargetProfile['originalSource'], pinnedOriginal: string | undefined,
  ): Promise<ResolvedGenerationOriginal> => {
    const original = await lookupRetainedGenerationDispatch({ store, correlation, originalSource,
      ...(pin === null ? {} : { originalIntentId: pin.originalIntentId }) });
    if (original.status !== 'resolved' || !controlAdapter!.available(original.retained.intent)) {
      throw new Error(`Generation control original is ${original.status}.`);
    }
    if (pinnedOriginal !== undefined && original.retained.intent.intentId !== pinnedOriginal) {
      throw new Error('Generation control selected original changed before pinning.');
    }
    return original;
  };
  const readControlReceipt = async (
    original: ResolvedGenerationOriginal, ctx: SystemCommandContext,
  ) => {
    const context = controlAdapter!.resultContext(original.retained.intent);
    if (context === null) throw new Error('Generation control lost the original request declaration.');
    resultContexts.set(original.retained.intent.intentId, context);
    const receipt = await readRetainedReceipt({ intent: original.retained.intent, context }, ctx);
    if (receipt === null) throw new Error('Generation control original receipt is absent.');
    await readCurrentGenerationAssociation(original, receipt, ctx);
    return { receipt, context };
  };
  const qualifyGenerationControlOnce = async (control: OutboxIntent, admission: GenerationControlAdmission,
    ctx: SystemCommandContext, pinnedOriginal?: string): Promise<GenerationControlObservation> => {
    const profile = dispatchGenerationTargetProfile(control.target);
    if (controlAdapter === null || profile?.role !== 'control' || profile.family !== options.profile || admission.fence.owner === '') {
      throw new Error('Generation control needs its actual cleanup owner fence.');
    }
    const revision = await store.readRevision();
    const guard = control.dispatchGuard ?? null;
    if (guard !== null && admission.evaluateGuard(guard, control.arguments,
        await admission.readStateSnapshot(control)) !== true) throw new Error('Generation cleanup guard no longer holds.');
    if (await admission.fence.revalidateAuthority() !== true) throw new Error('Generation cleanup authority was revoked.');
    const correlation = controlAdapter.controlCorrelation(control, admission.fence.owner);
    const controlRow = await ctx.load(WORK_DISPATCH_MODEL, control.intentId as RecordId);
    if (correlation === null || controlRow === null || controlRow.archivedAt !== null) {
      throw new Error('Generation control lost its checked durable correlation.');
    }
    const controlData = checkControlDurableCorrelation(control, correlation, controlRow);
    const pin = readDispatchImageControlPin(controlData);
    if (pin !== null && pin.observationStartedAtMs !== controlRow.created) throw new Error('Generation control pin lost its original creation time.');
    if (pinnedOriginal !== undefined && pin !== null && pin.originalIntentId !== pinnedOriginal) {
      throw new Error('Generation control original pin changed.');
    }
    const original = await resolveControlOriginal(correlation, pin, profile.originalSource, pinnedOriginal);
    const { receipt, context } = await readControlReceipt(original, ctx);
    if (await admission.fence.revalidateAuthority() !== true) throw new Error('Generation cleanup authority was revoked.');
    if (await store.readRevision() !== revision) throw new GenerationControlCheckpointMoved();
    return { original, correlation, receipt, admission, originalContext: context };
  };
  const sameGenerationReceipt = (before: AssociatedReceipt, after: AssociatedReceipt, context: ReceiptResultContext) =>
    before.revision === after.revision && before.status === after.status &&
    before.error?.code === after.error?.code && before.error?.message === after.error?.message &&
    (before.result === null ? after.result === null : after.result !== null &&
      sameRetainedEvidence({ kind: 'delivered', result: before.result }, { kind: 'delivered', result: after.result }, context,
        options.profile === 'images' ? 'images' : 'text'));
  const stoppedProgress = (correlation: DispatchImageCorrelation): RichRunWire => ({
    source: correlation.requestSource, revision: correlation.requestRevision,
    sequence: '0', state: 'cancelled', detail: 'Stopped before provider transport.',
    ...(options.profile === 'images' ? { outputs: [], charged_jobs: null } : { content: '', used_tokens: null }),
  } as RichRunWire);
  const stopPendingOriginal = async (
    current: GenerationControlObservation, observed: GenerationControlObservation,
    original: OutboxIntent, ctx: SystemCommandContext, revision: number,
  ): Promise<{ staged: SystemStaging; progress: RichRunWire }> => {
    const stopped = await stopOriginal!.stage({ intentId: original.intentId, correlation: observed.correlation, revision }, ctx);
    const answer = stopped.result as { stopped?: boolean; reason?: string };
    if (answer.stopped !== true && answer.reason !== 'already-stopped') throw new Error('Original generation attempt crossed the pending-stop boundary.');
    let staged: SystemStaging = stopped;
    if (answer.stopped === true) {
      const row = await readCurrentGenerationAssociation(current.original, current.receipt, ctx);
      const association = readAssociationRow(row);
      staged = mergeStaging(staged, { writes: [{ kind: 'update', model: RECEIPT_ASSOCIATION_MODEL as ModelName,
        id: row.id, expectedVersion: row.version, row: withAssociationRowData(row, {
          recordModel: row.data['recordModel'] as string, recordId: association.locator.recordId,
          field: association.locator.field, deliveryId: association.deliveryId, source: association.source, revision,
        }, { actor: ctx.actor, nowMs: ctx.now }) }] });
      if (progressed !== undefined) staged = mergeStaging(staged,
        await stageCheckedDeliveryProgress(progressed, original, observed.admission.fence.owner, ctx));
    }
    return { staged, progress: stoppedProgress(observed.correlation) };
  };
  const refreshOriginalProgress = async (
    current: GenerationControlObservation, observed: GenerationControlObservation,
    original: OutboxIntent, originalContext: ReceiptResultContext, progress: RichRunWire,
    ctx: SystemCommandContext, revision: number,
  ): Promise<SystemStaging | null> => {
    if (['succeeded', 'failed', 'skipped'].includes(current.receipt.status) ||
        (current.receipt.result !== null && sameRetainedEvidence({ kind: 'delivered', result: current.receipt.result },
          { kind: 'delivered', result: progress }, originalContext, options.profile === 'images' ? 'images' : 'text'))) {
      return null;
    }
    return mergeStaging({}, await stageRichProgress({ intent: original, context: originalContext,
      revision, progress, ...(progressed === undefined ? {} : { progressed: { producer: progressed, owner: observed.admission.fence.owner } }) }, ctx));
  };
  const acknowledgeReconcileDelivery = async (
    current: GenerationControlObservation, observed: GenerationControlObservation,
    original: OutboxIntent, originalContext: ReceiptResultContext, progress: RichRunWire,
    ctx: SystemCommandContext,
  ): Promise<SystemStaging | null> => {
    if (current.receipt.status !== 'succeeded' || current.receipt.result === null ||
        !['succeeded', 'failed', 'cancelled'].includes(progress.state) ||
        !sameRetainedEvidence({ kind: 'delivered', result: current.receipt.result },
          { kind: 'delivered', result: progress }, originalContext, options.profile === 'images' ? 'images' : 'text')) {
      return null;
    }
    // A fresh acknowledged reconcile is a new source occurrence, while the
    // immutable original provider snapshot keeps its receipt and sequence.
    // The holding claim/recovery row and this one physical fence prevent the
    // same control acknowledgement from publishing it twice.
    return mergeStaging({},
      await stageCheckedDeliveryProgress(progressed!, original, observed.admission.fence.owner, ctx));
  };
  const stageGenerationControl = async (control: OutboxIntent, observed: GenerationControlObservation,
    ctx: SystemCommandContext, revision: number, acknowledging: boolean): Promise<SystemStaging> => {
    const current = await qualifyGenerationControl(control, observed.admission, ctx, observed.original.retained.intent.intentId);
    const original = current.original.retained.intent;
    const originalContext = current.originalContext;
    if (!sameGenerationReceipt(observed.receipt, current.receipt, originalContext)) {
      throw new Error('Original generation receipt changed before the control join.');
    }
    let staged: SystemStaging = {};
    let progress = observed.progress;
    if (observed.stopPending === true) {
      const stopped = await stopPendingOriginal(current, observed, original, ctx, revision);
      staged = stopped.staged;
      progress = stopped.progress;
    } else if (progress !== undefined) {
      const refreshed = await refreshOriginalProgress(current, observed, original, originalContext, progress, ctx, revision);
      if (refreshed !== null) {
        staged = mergeStaging(staged, refreshed);
      } else if (acknowledging && control.target.endsWith('.reconcile') && progressed !== undefined) {
        const acknowledged = await acknowledgeReconcileDelivery(current, observed, original, originalContext, progress, ctx);
        if (acknowledged !== null) staged = mergeStaging(staged, acknowledged);
      }
    }
    if (progress !== undefined) staged = mergeStaging(staged, await stageRichProgress({ intent: control,
      context: requireResultContext(control.intentId), revision, progress }, ctx));
    else if (observed.failure !== undefined) staged = mergeStaging(staged, await stageRichProgress({ intent: control,
      context: requireResultContext(control.intentId), revision, outcome: { kind: 'failed', error: observed.failure } }, ctx));
    return staged;
  };
  const observeGenerationControl = async (control: OutboxIntent, admission: GenerationControlAdmission,
    ctx: SystemCommandContext, recovering: boolean, nowMs: () => number): Promise<{ observation: GenerationControlObservation; answer: DispatchProviderOutcome }> => {
    const observed = await qualifyGenerationControl(control, admission, ctx);
    const original = observed.original.retained.intent;
    const definitive = await readRetainedEvidence({ intent: original, context: observed.originalContext }, ctx);
    if (definitive?.kind === 'delivered') return { observation: { ...observed, progress: definitive.result as RichRunWire }, answer: definitive };
    if (definitive?.kind === 'failed') return { observation: { ...observed, failure: { code: definitive.code, message: definitive.message } },
      answer: { kind: 'failed', cause: { kind: 'permanent', code: definitive.code, message: definitive.message } } };
    if (observed.receipt.status === 'skipped' && observed.receipt.result === null ||
        control.target.endsWith('.cancel') && observed.receipt.status === 'pending' && observed.receipt.result === null) {
      const progress = stoppedProgress(observed.correlation);
      return { observation: { ...observed, stopPending: true, progress }, answer: { kind: 'delivered', result: progress } };
    }
    const row = await ctx.load(WORK_DISPATCH_MODEL, control.intentId as RecordId);
    if (row === null) throw new Error('Generation control lost its retained observation pin.');
    const pin = readDispatchImageControlPin(readDispatchRow(row));
    if (pin === null || pin.originalIntentId !== original.intentId) throw new Error('Generation control observation needs its immutable original pin.');
    let progress: RichRunWire | undefined;
    const common = { observation: { startedAtMs: pin.observationStartedAtMs, deadlineMs: pin.observationDeadlineMs }, recovering,
      originalScope: { app: observed.correlation.requestApp, owner: observed.correlation.requestOwner,
        principal: observed.original.principal } };
    const observeTextControl = async (): Promise<{ observation: GenerationControlObservation; answer: DispatchProviderOutcome }> => {
      if (textControls === null) throw new Error('Text controls need their positively installed adapter entries.');
      const answer = await textControls.observeControl(control, original, { ...common,
        nowMs,
        retainedProgress: observed.receipt.result as unknown as TextRunWire | null,
        onProgress: async (value: TextRunWire) => { progress = value; } });
      // The live Text adapter resolves only after its original progress commits.
      // Requalify that current association and preserve its actual terminal
      // evidence instead of writing the same sequence a second time.
      const current = await qualifyGenerationControl(control, admission, ctx, original.intentId);
      const terminal = await readRetainedEvidence({ intent: original, context: current.originalContext }, ctx);
      if (terminal?.kind === 'delivered') return {
        observation: { ...current, progress: terminal.result as unknown as TextRunWire }, answer: terminal };
      if (terminal?.kind === 'failed') return {
        observation: { ...current, failure: { code: terminal.code, message: terminal.message } },
        answer: { kind: 'failed', cause: { kind: 'permanent', code: terminal.code, message: terminal.message } } };
      if (!sameGenerationReceipt(observed.receipt, current.receipt, current.originalContext)) {
        return { observation: current, answer: { kind: 'uncertain' } };
      }
      return { observation: { ...current, ...(progress === undefined ? {} : { progress }) }, answer };
    };
    const observeImagesControl = async (): Promise<{ observation: GenerationControlObservation; answer: DispatchProviderOutcome }> => {
      const answer = await (options as BoundImagesDispatcherOptions).adapter.observeControl(control, original, {
        ...common,
        stagedAtMs: observed.original.row.created,
        ...(observed.receipt.result === null ? {} : { sequence: (observed.receipt.result as unknown as ImageRunWire).sequence }),
        onQueued: async () => { throw new Error('Images control cannot submit a replacement.'); },
        onProgress: async value => { progress = value; },
      });
      return { observation: { ...observed, ...(progress === undefined ? {} : { progress }) }, answer };
    };
    if (options.profile === 'text') return observeTextControl();
    return observeImagesControl();
  };
  return {
    async drive(supplied) {
      // Pin host functions and the fence container for this drive. These ports
      // do not establish native source/lexical authority.
      const suppliedFence = supplied.fence;
      const input = { ...supplied, fence: suppliedFence.asyncGuard === undefined
        ? Object.freeze({ ...suppliedFence })
        : Object.freeze({ ...suppliedFence, asyncGuard: Object.freeze({ ...suppliedFence.asyncGuard }) }) };
      const createClaimCommand = options.createClaimCommand;
      const available = options.adapter.available.bind(options.adapter);
      await refreshPending();
      const intent = pending.get(input.intentId);
      if (intent === undefined) return { status: 'not-pending', intentId: input.intentId };
      if (input.fence.asyncGuard !== undefined && intent.dispatchGuard != null &&
          dispatchGenerationTargetProfile(intent.target)?.role === 'control') {
        throw new Error('Generation cleanup requires its own execution-bound async guard qualification.');
      }
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
      const originalContexts: string[] = [];
      try {
        // The fence kernel preflights deployment availability before
        // guards/authority/claims. The bound dispatcher owns that
        // truth (adapter.available); the claim gate enforces the
        // same predicate, so preflight refuses exactly what
        // claiming would refuse — before any claim write.
        const driveOptions: Omit<DriveDispatchIntentOpts, 'registry'> = { ...input, store, intent,
          fence: { ...input.fence,
            availability: { isTargetAvailable: target =>
              target === intent.target && available(intent) &&
              (!isGenerationControl(intent) || controlAdapter !== null) } },
          callProvider: async (selected, held) => {
            const heldKey = `${selected.intentId}\0${held.claimId}`;
            progressOwners.set(heldKey, input.fence.owner);
            heldKeys.push(heldKey);
            let committedProgress: RichRunWire | undefined;
            let retainedCommitted = false;
            let retainedEvidence: DispatchReconcileEvidence | undefined;
            let answer: DispatchProviderOutcome;
            const context = !rich ? null : requireResultContext(selected.intentId);
            const originalFence = input.fence, revalidateAuthority = originalFence.revalidateAuthority;
            const current = (): boolean | Promise<boolean> => input.fence === originalFence &&
              originalFence.revalidateAuthority === revalidateAuthority ? revalidateAuthority.call(originalFence) : false;
            if (isWorkflowReview(selected)) {
              if (!await current()) throw new Error('Workflow review authority was revoked.');
              reviewAuthorities.set(heldKey, current);
            }
            const scope = { actor: input.actor, now: input.nowMs(), operation: input.operation,
              load: store.load.bind(store), query: store.query.bind(store) };
            const driveGenerationControl = async (): Promise<DispatchProviderOutcome> => {
              const admission = { fence: input.fence, evaluateGuard: input.evaluateGuard, readStateSnapshot: input.readStateSnapshot };
              const original = await qualifyGenerationControl(selected, admission, scope);
              originalContexts.push(retainControlContext(original));
              const row = await store.load(WORK_DISPATCH_MODEL, selected.intentId as RecordId);
              if (row === null) throw new Error('Generation control lost its held dispatch.');
              const saved = readDispatchImageControlPin(readDispatchRow(row));
              const observation = saved === null ? controlAdapter!.controlObservation(selected, row.created)
                : { startedAtMs: saved.observationStartedAtMs, deadlineMs: saved.observationDeadlineMs };
              if (observation === null || observation === undefined) throw new Error('Generation control observation policy is unavailable.');
              pinAdmissions.set(heldKey, { intent: selected, admission });
              await registry.run(pinCommand.name, { intentId: selected.intentId, claimId: held.claimId,
                originalIntentId: original.original.retained.intent.intentId, correlation: original.correlation, observation },
                { actor: input.actor, now: input.nowMs(), operation: input.operation,
                  operationId: `${held.claimId}:${options.profile === 'images' ? 'image' : 'text'}-control-pin` }, { store });
              const controlled = await observeGenerationControl(selected, admission, scope, saved !== null, () => input.nowMs());
              completions.set(heldKey, { intent: selected, outcome: controlled.answer, owner: input.fence.owner, control: controlled.observation });
              return controlled.answer;
            };
            if (controlAdapter !== null && isGenerationControl(selected)) {
              return driveGenerationControl();
            }
            const retained = context === null ? null
              : await readRetainedReceipt({ intent: selected, context }, scope);
            if (context !== null && retained === null) {
              throw new Error('Generation needs its original durable receipt before transport.');
            }
            const settleDurableReceipt = async (): Promise<DispatchProviderOutcome | null> => {
              if (context === null || retained === null || (retained.result === null && retained.status === 'pending')) return null;
              // A reclaimed claim never restarts a run which already crossed
              // the durable pre-transport queue boundary. Only confirmed
              // original terminal evidence can settle that uncertain attempt.
              const definitive = await readRetainedEvidence({ intent: selected, context }, scope);
              retainedCommitted = definitive !== null;
              retainedEvidence = definitive ?? undefined;
              return definitive?.kind === 'delivered' ? definitive
                : definitive?.kind === 'failed' ? { kind: 'failed', cause: { kind: 'permanent',
                    code: definitive.code, message: definitive.message } }
                : { kind: 'uncertain' };
            };
            const settled = await settleDurableReceipt();
            if (settled !== null) {
              answer = settled;
            } else {
              const commitProgress = async (progress: RichRunWire,
                files: FrameworkFilePayloadOriginInput['files'] = []): Promise<void> => {
                if (progressFiles.has(heldKey)) throw new Error('Concurrent Images progress execution refused.');
                // Keep issuer identity private; only unchanged provider wire
                // crosses the existing Work command JSON boundary.
                const captured = Object.freeze(files.map(entry => Object.freeze({
                  path: Object.freeze([...entry.path]), observation: entry.observation })));
                progressFiles.set(heldKey, { json: stableStringify(progress), files: captured, current, consumed: false });
                try {
                  await registry.run(progressCommand.name, { intentId: selected.intentId, claimId: held.claimId, progress },
                    { actor: input.actor, now: input.nowMs(), operation: input.operation,
                      operationId: `${held.claimId}:progress:${progress.sequence}` }, { store });
                  committedProgress = progress;
                } finally { progressFiles.delete(heldKey); }
              };
              const driveMailTransport = async (adapter: BoundMailAdapter): Promise<DispatchProviderOutcome> => {
                const recipient = adapter.userRecipient(selected);
                const refused = (): DispatchProviderOutcome => ({ kind: 'failed', cause: {
                  kind: 'permanent', code: 'recipient_unavailable', message: 'Mail recipient unavailable.' } });
                if (recipient === null || recipient.team !== input.fence.owner || !await adapter.recipientActive(selected)) return refused();
                const row = await store.load(WORK_DISPATCH_MODEL, selected.intentId as RecordId);
                if (row === null) throw new Error('Private mail recipient lost its original dispatch.');
                const saved = readDispatchMailRecipientPin(readDispatchRow(row));
                if (saved !== null && (saved.mailRecipientUser !== recipient.user || saved.mailRecipientTeam !== recipient.team)) {
                  throw new Error('Private mail recipient differs from its original intent.');
                }
                const email = saved?.mailRecipientEmail ?? await adapter.resolveRecipient(selected);
                if (email === null) return refused();
                const recipientCurrent = async () => Boolean(await current()) && await adapter.recipientActive(selected);
                mailPins.set(heldKey, { intent: selected, current: recipientCurrent, email });
                try {
                  await registry.run(mailPinCommand.name, { intentId: selected.intentId, claimId: held.claimId,
                    mailRecipientUser: recipient.user, mailRecipientTeam: recipient.team, mailRecipientEmail: email },
                    { actor: input.actor, now: input.nowMs(), operation: input.operation,
                      operationId: `${held.claimId}:mail-recipient-pin` }, { store });
                  // The exact persisted pin must survive the commit before transport.
                  const pinned = await store.load(WORK_DISPATCH_MODEL, selected.intentId as RecordId);
                  const pin = pinned === null ? null : readDispatchMailRecipientPin(readDispatchRow(pinned));
                  if (pin === null || pin.mailRecipientEmail !== email) throw new Error('Private mail recipient pin unavailable.');
                  return await recipientCurrent() ? await adapter.callProvider(selected, pin.mailRecipientEmail) : refused();
                } finally { mailPins.delete(heldKey); }
              };
              const driveImagesTransport = async (adapter: BoundImagesAdapter): Promise<DispatchProviderOutcome> => {
                const original = await store.load(WORK_DISPATCH_MODEL, selected.intentId as RecordId);
                if (original === null) throw new Error('Images transport lost its original staged attempt.');
                const execution = readDispatchExecutionRow(original);
                if (execution.state !== 'claimed' || execution.claimId !== held.claimId) {
                  throw new Error('Images transport needs its current held claim.');
                }
                const receiptRow = await store.load(RECEIPT_MODEL as ModelName, selected.intentId as RecordId);
                const originalHeader = receiptRow === null ? undefined : readReceiptRow(receiptRow, context!).filePayloadOrigin;
                if (isWorkflowReview(selected)) {
                  if (!await current()) throw new Error('Workflow review authority was revoked.');
                  reviewAuthorities.set(heldKey, current);
                }
                const answer = await adapter.callProvider(selected, { stagedAtMs: original.created,
                  ...(originalHeader === undefined ? {} : { originalScope: { app: originalHeader.scope.app,
                    owner: originalHeader.scope.owner, principal: receiptRow!.createdBy } }),
                  onQueued: commitProgress, onProgress: commitProgress });
                if (isWorkflowReview(selected) && !await current()) throw new Error('Workflow review authority changed during review.');
                return answer;
              };
              if (options.profile === 'mail' && selected.target === 'std.EmailV1.send_user') {
                answer = await driveMailTransport(options.adapter);
              } else if (options.profile === 'mail' || options.profile === 'judgment') answer = await options.adapter.callProvider(selected);
              else if (options.profile === 'text') answer = await options.adapter.callProvider(selected, { onProgress: commitProgress });
              else answer = await driveImagesTransport(options.adapter);
            }
            const key = `${selected.intentId}\0${held.claimId}`;
            completions.set(key, { intent: selected, outcome: answer, owner: input.fence.owner,
              ...(retainedEvidence === undefined ? {} : { retainedEvidence }),
              progressCommitted: retainedCommitted || answer.kind === 'delivered' &&
                committedProgress !== undefined && answer.result === committedProgress });
            return answer;
          } };
        const outcome = input.fence.asyncGuard !== undefined && intent.dispatchGuard != null
          ? await driveDispatchIntentWithPreclaim(driveOptions, (guard, allocator) => {
            let eligible: DispatchClaimGuardInput | undefined;
            const guardedClaim = createClaimCommand((id, target) => id === intent.intentId &&
              target === intent.target && (!isGenerationControl(intent) || controlAdapter !== null),
            async frame => { eligible = frame; return guard(frame); }, allocator);
            if (guardedClaim.name !== claim.name) throw new Error('Preclaim needs the defining Work claim command.');
            const originalStage = (guardedClaim as SystemCommandDef).stage;
            if (typeof originalStage !== 'function') throw new Error('Preclaim needs the defining Work claim stage.');
            const joinedClaim: SystemCommandDef = { ...guardedClaim, async stage(args, ctx) {
              const staged = await originalStage.call(guardedClaim, args, ctx);
              const result = staged.result;
              if (typeof result !== 'object' || result === null || Array.isArray(result) ||
                  (result as Record<string, unknown>)['claimed'] !== false ||
                  (result as Record<string, unknown>)['reason'] !== 'guard-false' ||
                  !staged.outboxAck?.includes(intent.intentId)) return staged;
              // This is the unchanged row/context supplied by the actual Work
              // guard. An old held claim or attempted provider work cannot be
              // converted to a new empty skipped receipt.
              const checkSkippedPreclaim = (): void => {
                if (eligible === undefined || eligible.context !== ctx || eligible.row.id !== intent.intentId ||
                    (result as Record<string, unknown>)['intentId'] !== intent.intentId ||
                    eligible.data.state !== 'pending' || eligible.data.attempts !== 0 ||
                    eligible.data.claimId !== null || eligible.data.claimedAtMs !== null) {
                  throw new Error('Skipped receipt requires the actual untouched eligible preclaim.');
                }
              };
              const checkSkippedDispatchWrite = (): void => {
                const actual = staged.writes?.filter(write => write.kind === 'update' &&
                  write.model === WORK_DISPATCH_MODEL && write.id === intent.intentId);
                if (actual?.length !== 1 || actual[0]!.kind !== 'update') {
                  throw new Error('Skipped receipt lost its genuine guard-false dispatch write.');
                }
                const dispatch = readDispatchRow(actual[0]!.row);
                if (dispatch.intentId !== intent.intentId || dispatch.guardVerdict !== false || dispatch.attempts !== 0 ||
                    dispatch.state !== 'pending' || dispatch.claimId !== null || dispatch.claimedAtMs !== null) {
                  throw new Error('Skipped receipt disagrees with its actual guard-false dispatch.');
                }
              };
              checkSkippedPreclaim();
              checkSkippedDispatchWrite();
              const receipt = await stageReceiptProgress({ intent, outcome: { kind: 'skipped' },
                revision: systemCommandStageRevision(ctx) + 1,
                ...(options.profile === 'mail' ? {} : { context: requireResultContext(intent.intentId) }) }, ctx);
              // Original State phase checks, dispatch writes and ACK stay in
              // this same command/fence; no provider or second commit runs.
              return mergeStaging(staged, receipt);
            } };
            return registryForClaim(joinedClaim);
          })
          : await driveDispatchIntent({ ...driveOptions, registry });
        if (outcome.status === 'unavailable') {
          // Fenced send refused before guards: the deployment
          // bindings declared this target unavailable, so no
          // provider call ran. Seed the completion the record hook
          // needs and terminalize through the same failed path as
          // provider failures: failed/terminal receipt + record +
          // ack under the held claim. Never re-driven.
          const key = `${intent.intentId}\0${outcome.claimId}`;
          const message = `Send target ${intent.target} is unavailable in this deployment.`;
          completions.set(key, { intent,
            outcome: { kind: 'failed',
              cause: { kind: 'permanent', code: 'unavailable', message } },
            owner: input.fence.owner });
          heldKeys.push(key);
          const recorded = await registry.run('work.dispatch.record-attempt',
            { intentId: intent.intentId, claimId: outcome.claimId,
              outcome: { state: 'failed', retryClass: 'terminal',
                errorCode: 'unavailable', errorMessage: message },
              ack: true },
            { actor: input.actor, now: input.nowMs(), operation: input.operation,
              operationId: `${outcome.claimId}:unavailable-terminal` }, { store });
          checkRecordResult(recorded.result);
        }
        await refreshPending();
        // The fenced unavailable verdict (terminalized above) and
        // the legacy claim-refused shape converge on the same
        // bound outcome; the fence port normally preflights before
        // the claim gate can refuse.
        return outcome.status === 'unavailable'
          ? { status: 'unavailable', intentId: intent.intentId, target: outcome.target }
          : outcome.status === 'not-claimed' && outcome.reason === 'unavailable'
            ? { status: 'unavailable', intentId: intent.intentId, target: intent.target }
            : outcome;
      } finally {
        for (const key of heldKeys) { completions.delete(key); progressOwners.delete(key); pinAdmissions.delete(key); reviewAuthorities.delete(key); }
        for (const id of originalContexts) releaseControlContext(id);
      }
    },
    async recover(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1) {
        throw new Error('Installed mail recovery needs a positive integer scan limit.');
      }
      const admitGenerationRecovery = async (intent: OutboxIntent, expectedRevision?: number) => {
        const admitted = input.admission;
        if (admitted === undefined || admitted.fence.owner === '' ||
            typeof admitted.fence.revalidateAuthority !== 'function' ||
            typeof admitted.evaluateGuard !== 'function' || typeof admitted.readStateSnapshot !== 'function') {
          throw new Error('Generation recovery requires its actual current host owner admission.');
        }
        const producer = await loadFenceAdmissionProducer();
        const checkpoint = (await producer.openTransitiveScope(store, admitted.fence.owner)).snapshot();
        const trigger = admitted.fence.triggerRevision;
        if (trigger !== undefined && (!Number.isSafeInteger(trigger.revision) || trigger.revision < 0 ||
            checkpoint.revision === trigger.revision)) {
          throw new Error('Generation recovery cannot inherit its triggering checkpoint.');
        }
        const guard = intent.dispatchGuard ?? null;
        if (guard !== null && admitted.fence.asyncGuard !== undefined) {
          throw new Error('Generation recovery requires its own execution-bound async guard qualification.');
        }
        const snapshot = guard === null ? null : await admitted.readStateSnapshot(intent);
        if (guard !== null && admitted.evaluateGuard(guard, intent.arguments, snapshot) !== true) {
          throw new Error('Generation recovery dispatch guard no longer holds.');
        }
        if (await admitted.fence.revalidateAuthority() !== true) {
          throw new Error('Generation recovery current authority was revoked.');
        }
        if (await store.readRevision() !== checkpoint.revision ||
            (expectedRevision !== undefined && checkpoint.revision !== expectedRevision)) {
          throw new Error('Generation recovery admission revision changed.');
        }
        return checkpoint;
      };
      // Services is asynchronous, while Work's planner reads evidence
      // synchronously. Only confirmed evidence crosses this small join.
      await refreshPending();
      const evidence = new Map<string, DispatchReconcileEvidence>();
      const retainedEvidence = new Set<string>();
      const imageObservations = new Map<string, { receipt: AssociatedReceipt; progress: ImageRunWire;
        files: FrameworkFilePayloadOriginInput['files'] }>();
      const controlObservations = new Map<string, GenerationControlObservation>();
      const observedControlOriginals = new Set<string>();
      const retainedContext = { actor: input.actor, now: input.nowMs(), operation: input.operation,
        load: store.load.bind(store), query: store.query.bind(store) };
      const originalContexts: string[] = [];
      const recoverControlRow = async (intent: OutboxIntent, row: StoredRow): Promise<void> => {
        const admission = input.admission!;
        const checked = await qualifyGenerationControl(intent, admission, retainedContext);
        originalContexts.push(retainControlContext(checked));
        const pin = readDispatchImageControlPin(readDispatchRow(row));
        if (pin === null || pin.originalIntentId !== checked.original.retained.intent.intentId) return;
        const definitive = await readRetainedEvidence({ intent, context: requireResultContext(intent.intentId) }, retainedContext);
        if (definitive !== null) {
          retainedEvidence.add(intent.intentId); evidence.set(intent.intentId, definitive);
          return;
        }
        const originalId = checked.original.retained.intent.intentId;
        const originalDefinitive = await readRetainedEvidence({ intent: checked.original.retained.intent,
          context: checked.originalContext }, retainedContext);
        const retainedStop = checked.receipt.status === 'skipped' && checked.receipt.result === null;
        // Recovery observes its page before committing each outcome. Two
        // fresh observations of one original would share an old receipt
        // checkpoint; the first join would invalidate the second. Retained
        // terminal/stop evidence needs no new original write or transport.
        if (originalDefinitive === null && !retainedStop) {
          if (observedControlOriginals.has(originalId)) return;
          observedControlOriginals.add(originalId);
        }
        const controlled = await observeGenerationControl(intent, admission, retainedContext, true, () => input.nowMs());
        if (controlled.answer.kind === 'delivered') {
          controlObservations.set(intent.intentId, controlled.observation);
          evidence.set(intent.intentId, { kind: 'delivered', result: controlled.answer.result });
        } else if (controlled.observation.failure !== undefined) {
          controlObservations.set(intent.intentId, controlled.observation);
          evidence.set(intent.intentId, { kind: 'failed', ...controlled.observation.failure });
        }
      };
      const recoverOriginalRow = async (intent: OutboxIntent, row: StoredRow): Promise<void> => {
        const retained = !rich ? null
          : await readRetainedEvidence({ intent,
            context: requireResultContext(intent.intentId) }, retainedContext);
        let answer = retained;
        if (answer === null) {
          if (options.profile === 'images' && isWorkflowReview(intent)) {
            answer = await options.adapter.reconcile(intent, { stagedAtMs: row.created,
              onQueued: async () => { throw new Error('Workflow review cannot queue generation.'); },
              onProgress: async () => { throw new Error('Workflow review cannot report generation progress.'); } });
          } else if (options.profile !== 'images') answer = await options.adapter.reconcile(intent);
          else {
            const receipt = await readRetainedReceipt({ intent,
              context: requireResultContext(intent.intentId) }, retainedContext);
            if (receipt === null) throw new Error('Images recovery lost its original durable receipt.');
            const sequence = receipt.result === null ? undefined
              : (receipt.result as unknown as ImageRunWire).sequence;
            let observed: ImageRunWire | undefined;
            let observedFiles: FrameworkFilePayloadOriginInput['files'] = [];
            const receiptRow = await store.load(RECEIPT_MODEL as ModelName, intent.intentId as RecordId);
            const header = receiptRow === null ? undefined : readReceiptRow(receiptRow,
              requireResultContext(intent.intentId)).filePayloadOrigin;
            answer = await options.adapter.reconcile(intent, {
              ...(header === undefined ? {} : { originalScope: { app: header.scope.app,
                owner: header.scope.owner, principal: receiptRow!.createdBy } }),
              stagedAtMs: row.created, ...(sequence === undefined ? {} : { sequence }),
              onQueued: async () => { throw new Error('Images recovery cannot submit a new job.'); },
              // Reconciliation only observes the original installed job. Its
              // confirmed terminal evidence is staged in the existing recovery
              // batch below; nonterminal observations never authorize ack.
              onProgress: async (progress, files = []) => {
                observed = progress;
                observedFiles = Object.freeze(files.map(entry => Object.freeze({
                  path: Object.freeze([...entry.path]), observation: entry.observation })));
              },
            });
            if (answer?.kind === 'delivered') {
              const checkedContext = requireResultContext(intent.intentId);
              if (observed === undefined || !['succeeded', 'failed', 'cancelled'].includes(observed.state) ||
                  !sameRetainedEvidence(answer, { kind: 'delivered', result: observed }, checkedContext, 'images')) {
                throw new Error('Images recovery needs its actual confirmed terminal observation.');
              }
              imageObservations.set(intent.intentId, { receipt, progress: observed, files: observedFiles });
            }
          }
        }
        if (retained !== null) retainedEvidence.add(intent.intentId);
        if (answer !== null) evidence.set(intent.intentId, answer);
      };
      try {
        // The existing recovery planner selects its bounded page by intent ID.
        // Fetch that same page, rather than D1's default creation-time order.
        const rows = await store.query({ ...dispatchByStateQuery('uncertain'),
          order: [{ field: 'id', direction: 'asc' }], limit: input.limit });
        // One bounded page must not observe and then overwrite the same original
        // twice. Its pinned cleanup delivery owns this sweep's observation join.
        const controlledOriginals = new Set(rows.flatMap(row => {
          const data = readDispatchRow(row);
          const intent = pending.get(data.intentId);
          const profile = intent === undefined ? null : dispatchGenerationTargetProfile(intent.target);
          const pin = intent !== undefined && profile?.role === 'control' && profile.family === options.profile &&
          controlAdapter !== null && options.adapter.available(intent) ? readDispatchImageControlPin(data) : null;
          return pin === null ? [] : [pin.originalIntentId];
        }));
        for (const row of rows) {
          const dispatch = readDispatchExecutionRow(row);
          if (dispatch.state !== 'uncertain') continue;
          const intent = pending.get(dispatch.intentId);
          if (intent === undefined || !options.adapter.available(intent)) continue;
          if (isGenerationControl(intent) && controlAdapter === null) continue;
          if (rich && controlledOriginals.has(intent.intentId) &&
              await readRetainedEvidence({ intent, context: requireResultContext(intent.intentId) }, retainedContext) === null) continue;
          if (options.profile === 'images' || rich && isGenerationControl(intent)) await admitGenerationRecovery(intent);
          if (controlAdapter !== null && isGenerationControl(intent)) {
            await recoverControlRow(intent, row);
            continue;
          }
          await recoverOriginalRow(intent, row);
        }
        const outcome = await runRecoverySweep({ ...input, registry, store, joinPort,
          readEvidence: id => evidence.get(id) ?? null,
          ...(!rich ? {} : { revalidateReconciledReceipt: async (
            { intentId, revision }: { readonly intentId: string; readonly revision: number },
          ) => {
            const intent = pending.get(intentId);
            if (options.profile === 'text' && intent !== undefined && !isGenerationControl(intent)) return;
            if (intent === undefined || !options.adapter.available(intent)) {
              throw new Error('Generation recovery acknowledgement lost its original pending intent.');
            }
            await admitGenerationRecovery(intent, revision);
            if (isGenerationControl(intent)) {
              await qualifyGenerationControl(intent, input.admission!, retainedContext);
            }
          } }),
          stageReconciledReceipt: async ({ intentId, evidence: answer, revision, context }) => {
            const admitReconciledIntent = async () => {
              const intent = pending.get(intentId);
              if (intent === undefined || !options.adapter.available(intent)) {
                throw new Error('Reconciled mail lost its installed original intent.');
              }
              const admitted = options.profile === 'images' || rich && isGenerationControl(intent)
                ? await admitGenerationRecovery(intent, revision - 1) : undefined;
              return { intent, admitted };
            };
            const acknowledgeRetainedEvidence = async (intent: OutboxIntent): Promise<never[] | null> => {
              if (!retainedEvidence.has(intentId)) return null;
              // Re-read the original terminal receipt in the recovery batch's
              // scope. Its progress was already committed: only acknowledge the
              // intent, without giving that same sequence a new checkpoint.
              const checkedContext = requireResultContext(intentId);
              const retained = await readRetainedEvidence({ intent, context: checkedContext }, context);
              if (!sameRetainedEvidence(answer, retained, checkedContext, options.profile === 'images' ? 'images' : 'text')) {
                throw new Error('Retained generation outcome changed before acknowledgement.');
              }
              return [];
            };
            const checkImageObservation = async (intent: OutboxIntent): Promise<void> => {
              const observation = imageObservations.get(intentId);
              if (observation === undefined) return;
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
            };
            const { intent, admitted } = await admitReconciledIntent();
            if (isWorkflowReview(intent)) {
              await readRetainedReceipt({ intent, context: requireResultContext(intentId) }, context);
            }
            const control = controlObservations.get(intentId);
            if (control !== undefined) return stageGenerationControl(intent, control, context, revision, true);
            if (rich && isGenerationControl(intent)) {
              await qualifyGenerationControl(intent, input.admission!, context);
            }
            const retainedAck = await acknowledgeRetainedEvidence(intent);
            if (retainedAck !== null) return retainedAck;
            await checkImageObservation(intent);
            const outcome = answer.kind === 'delivered'
              ? { kind: 'delivered' as const, result: answer.result }
              : { kind: 'failed' as const, error: { code: answer.code, message: answer.message } };
            if (usesRichProgress(intent) && progressed !== undefined && admitted === undefined) {
              throw new Error('New recovered progress needs the original admitted owner fence before occurrence staging.');
            }
            // Images observation recovery revalidates current authority in
            // `revalidateReconciledReceipt` (via `admitGenerationRecovery`)
            // immediately before commit. A commit check cannot enroll here:
            // the reconcile staging context is hand-built, never
            // registry-issued.
            // Review recovery uses revalidateReconciledReceipt, the owning
            // recovery driver's authority/revision check immediately before commit.
            return (!usesRichProgress(intent)
              ? await stageReceiptProgress({ intent, outcome, revision,
                ...(typed ? { context: requireResultContext(intent.intentId) } : {}) }, context)
              : await stageRichProgress({ intent, context: requireResultContext(intent.intentId), revision,
                ...(progressed === undefined || admitted === undefined ? {} : {
                  progressed: { producer: progressed, owner: admitted.owner },
                }),
                ...(outcome.kind === 'delivered' ? { progress: outcome.result as RichRunWire } : { outcome }) }, context,
                imageObservations.get(intentId)?.files));
          } });
        await refreshPending();
        return outcome;
      } finally {
        for (const id of originalContexts) releaseControlContext(id);
      }
    },
  };
}

export { resolveGenerationCallbackOrigin } from './generation-callback-origin.js';
