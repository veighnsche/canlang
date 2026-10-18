/** Repair only File attachments proven by this authenticated committed SEND. */
import type { CompileArtifact, FrameworkFilePayloadOrigin, Receipt, ResolvedIdentity, Revision, StoragePort, WorkScope } from '@canlang/contracts';
import { receiverFromIdentity } from '@canlang/interfaces';
import { stableStringify } from '@canlang/state/invocation';
import { WORK_DISPATCH_MODEL, readDispatchRow } from '@canlang/work/kernel/tables';
import type { CanonicalFileBinding } from './file-staging.js';
import type { RetainedOpaqueFileSource } from './opaque-file-staging.js';

type QueueRetentionInput = Parameters<typeof retainCommittedQueueFiles>[0];

type CheckedQueueHeader = Exclude<ReturnType<typeof readDispatchRow>['queuePayloadOrigin'], undefined>;

type QueuePublicationIntent = Extract<Extract<FrameworkFilePayloadOrigin['origin'], { kind: 'event-input' }>['target'], { kind: 'queue-publication' }>['intent'];

async function verifyQueueOutboxPublication(
  input: QueueRetentionInput,
  row: Parameters<typeof readDispatchRow>[0],
  dispatch: ReturnType<typeof readDispatchRow>,
  publication: QueuePublicationIntent,
  receipt: Receipt,
  revision: Awaited<ReturnType<QueueRetentionInput['store']['readRevision']>>,
): Promise<void> {
  const retained = input.store.outboxGetBounded === undefined ? await input.store.outboxGet(row.id)
    : await input.store.outboxGetBounded({ intentId: row.id, expectedRevision: revision });
  if (retained === null || retained.status === 'skipped' || retained.originalCommit?.revision !== receipt.committedRevision ||
      retained.originalCommit.createdAt !== receipt.createdAt || retained.intent.operation !== publication.operation ||
      retained.intent.operationId !== publication.operationId || retained.intent.intentId !== publication.intentId ||
      retained.intent.target !== publication.target || retained.intent.occurrenceIndex !== publication.occurrenceIndex ||
      stableStringify(retained.intent.arguments['arguments']) !== stableStringify(dispatch.queuePayload)) {
    throw new Error('Queue retention lacks its original atomic outbox publication.');
  }
}

async function verifyQueueDispatchRow(
  input: QueueRetentionInput,
  row: Parameters<typeof readDispatchRow>[0],
  dispatch: ReturnType<typeof readDispatchRow>,
  header: CheckedQueueHeader,
  receipt: Receipt,
  caller: ReturnType<typeof receiverFromIdentity>,
  revision: Awaited<ReturnType<QueueRetentionInput['store']['readRevision']>>,
): Promise<void> {
  if (receipt.identity.principal !== caller.principal || receipt.identity.owner !== caller.owner) {
    throw new Error('Queue retention requires its authenticated receiving principal.');
  }
  const origin = header.origin;
  if (origin.kind !== 'event-input' || origin.target.kind !== 'queue-publication') throw new Error('Queue retention lost its original publication header.');
  const publication = origin.target.intent;
  const queues = input.artifact.runtimeBindings?.filter(binding => binding.kind === 'queue' &&
    `${binding.binding}.publish` === publication.target && binding.owner === header.scope.ownerPackage) ?? [];
  if (queues.length !== 1 || header.scope.app !== receipt.identity.app || header.scope.owner !== receipt.identity.owner ||
      publication.operation !== receipt.identity.operation || publication.operationId !== receipt.identity.operationId ||
      publication.intentId !== row.id || dispatch.intentId !== row.id || dispatch.operationId !== publication.operationId ||
      dispatch.source !== publication.target || dispatch.occurrenceIndex !== publication.occurrenceIndex) {
    throw new Error('Queue retention differs from its exact original owner and SEND.');
  }
  await verifyQueueOutboxPublication(input, row, dispatch, publication, receipt, revision);
}

async function retainQueueRowFiles(
  input: QueueRetentionInput,
  header: CheckedQueueHeader,
  row: Parameters<typeof readDispatchRow>[0],
  receipt: Receipt,
  caller: ReturnType<typeof receiverFromIdentity>,
  revision: Awaited<ReturnType<QueueRetentionInput['store']['readRevision']>>,
  checkReceipt: () => Promise<void>,
): Promise<void> {
  const source: RetainedOpaqueFileSource = { model: WORK_DISPATCH_MODEL, row, field: 'queuePayload', binding: header };
  await input.verifySource(source, header.scope, revision);
  await checkReceipt();
  for (const { file } of header.files) {
    if (stableStringify(file.receiver) !== stableStringify(caller)) throw new Error('Queue retention cannot borrow another receiving principal.');
    // Files owns current availability and the actual attachment clock. Never
    // backdate a marker from a receipt or revive an expired physical file.
    if (!await input.files.validate(file.ref, input.identity, receipt.identity.app)) throw new Error('Committed queue File attachment requires retry.');
    await checkReceipt();
    await input.files.retain(file.ref, `${WORK_DISPATCH_MODEL}/${row.id}/queuePayload`, input.identity, receipt.identity.app);
  }
  await checkReceipt();
}

export async function retainCommittedQueueFiles(input: {
  readonly artifact: CompileArtifact;
  readonly receipt: Receipt;
  readonly identity: ResolvedIdentity;
  readonly store: StoragePort;
  readonly files: CanonicalFileBinding;
  readonly verifySource: (source: RetainedOpaqueFileSource, scope: WorkScope, revision: Revision) => Promise<void>;
}): Promise<void> {
  // Background handlers borrow existing retained observations. They cannot mint
  // an upload principal or repair attachments on behalf of a historical actor.
  if (input.identity.actor === null) return;
  const receipt = input.receipt, caller = receiverFromIdentity(receipt.identity.app, input.identity);
  if (receipt.outcome.status !== 'committed') throw new Error('Queue retention requires its committed receipt.');
  const revision = await input.store.readRevision();
  const checkReceipt = async () => {
    if (await input.store.readRevision() !== revision ||
        stableStringify(await input.store.readReceipt(receipt.identity)) !== stableStringify(receipt)) {
      throw new Error('Queue retention lost its original committed receipt or owner revision.');
    }
  };
  await checkReceipt();
  let cursor: string | null = null;
  for (;;) {
    const rows = await input.store.query({ model: WORK_DISPATCH_MODEL, authority: 'owner',
      where: { op: 'and', args: [{ op: 'eq', field: 'operationId', value: receipt.identity.operationId },
        ...(cursor === null ? [] : [{ op: 'gt' as const, field: 'id', value: cursor }])] },
      order: [{ field: 'id', direction: 'asc' }], limit: 100 });
    await checkReceipt();
    if (rows.length === 0) return;
    for (const row of rows) {
      const dispatch = readDispatchRow(row), header = dispatch.queuePayloadOrigin;
      if (header === undefined || header.files.length === 0) continue;
      await verifyQueueDispatchRow(input, row, dispatch, header, receipt, caller, revision);
      await retainQueueRowFiles(input, header, row, receipt, caller, revision, checkReceipt);
    }
    const next = rows[rows.length - 1]!.id;
    if (next === cursor) throw new Error('Queue retention did not advance its original SEND census.');
    cursor = next;
  }
}
