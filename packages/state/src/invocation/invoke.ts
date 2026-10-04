/**
 * Lane 03 S3: canonical mutation invocation with the revision-fence retry loop.
 *
 * The admission clock is frozen once across retries. Fence conflicts re-admit
 * from scratch (submitted versions are re-checked, so still-stale versions
 * conflict instead of overwriting); anything else from the commit maps to a
 * stable business error. S3 results carry no `records` member and return the
 * saved `result` unprojected; S4 adds changed-record projections and
 * current-access result projection.
 */

import type {
  AdmissionKind,
  DomainWrite,
  HistoryEntry,
  ModelName,
  OperationName,
  OutboxIntent,
  Receipt,
  RecordId,
  RecordVersion,
  Revision,
  ScheduleOp,
  StoragePort,
  UniqueClaim,
  UniqueRelease,
} from '../../../contracts/src/state.js';
import type {
  DeliveryReceipt,
  MutationEnvelope,
  MutationResult,
} from '../../../contracts/src/wire.js';
import type { ResolvedIdentity } from '../../../contracts/src/identity.js';
import type { OperationRegistry } from './registry.js';
import type { MembershipReader } from '../policy/roles.js';
import { admit, receiptIdentityFor, type AdmittedCall } from './admission.js';
import { buildContext, type ClockPort } from './context.js';
import { StateError, storageToStateError } from '../errors.js';
import { FenceConflictError } from '../storage/port.js';

/** Fenced-commit attempts per invocation, per DESIGN §7. */
export const MAX_ADMISSION_ATTEMPTS = 3;

/** Provisional outcome of one execution pass, committed atomically or dropped. */
export interface ExecutionEffects {
  writes: DomainWrite[];
  history: HistoryEntry[];
  outbox: OutboxIntent[];
  schedules: ScheduleOp[];
  uniqueClaims: UniqueClaim[];
  uniqueReleases: UniqueRelease[];
  resolvedDefaults: Record<string, unknown>;
  result: unknown;
}

/** S3 execution seam: interim handlers implement business evaluation. */
export type ExecuteHandler = (call: AdmittedCall) => Promise<ExecutionEffects>;

// `remove` writes are excluded: there is no resulting version to record,
// and the audit trail for removals lives in the committed history entries.
function recordVersionsOf(writes: ReadonlyArray<DomainWrite>): Array<{
  readonly model: ModelName;
  readonly id: RecordId;
  readonly version: RecordVersion;
}> {
  const versions: Array<{ readonly model: ModelName; readonly id: RecordId; readonly version: RecordVersion }> = [];
  for (const write of writes) {
    if (write.kind === 'insert') {
      versions.push({ model: write.model, id: write.row.id, version: write.row.version });
    } else if (write.kind === 'update') {
      versions.push({ model: write.model, id: write.id, version: write.row.version });
    }
  }
  return versions;
}

/**
 * Invoke one canonical mutation envelope. Unknown operations are `validation`
 * failures; exhausted fence contention is a retryable `busy`.
 */
export async function invoke(input: {
  registry: OperationRegistry;
  envelope: MutationEnvelope;
  identity: ResolvedIdentity;
  /** Selected deployment app; part of the receipt identity. */
  app: string;
  source: string;
  store: StoragePort;
  memberships: MembershipReader;
  clock: ClockPort;
  kind?: AdmissionKind;
  trustedSource?: string;
  execute: ExecuteHandler;
}): Promise<MutationResult> {
  const def = input.registry.get(input.envelope.operation);
  if (def === undefined) {
    throw new StateError('validation', `Unknown operation "${input.envelope.operation}".`);
  }
  const now = input.clock.nowMs();
  const context = buildContext({
    identity: input.identity,
    operation: input.envelope.operation as OperationName,
    operationId: input.envelope.operation_id,
    app: input.app,
    source: input.source,
    now,
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.trustedSource !== undefined ? { trustedSource: input.trustedSource } : {}),
  });

  for (let attempt = 1; attempt <= MAX_ADMISSION_ATTEMPTS; attempt += 1) {
    const call = await admit({
      def,
      inputs: input.envelope.inputs,
      context,
      store: input.store,
      memberships: input.memberships,
    });
    if (call.replay !== null) {
      const outcome = call.replay.outcome;
      if (outcome.status === 'rejected') {
        throw new StateError(outcome.code, outcome.message);
      }
      return {
        status: 'replayed',
        operation_id: input.envelope.operation_id,
        result: outcome.result ?? null,
      };
    }
    const effects = await input.execute(call);
    const receipt: Receipt = {
      identity: receiptIdentityFor(context),
      inputHash: call.inputHash,
      resolvedDefaults: effects.resolvedDefaults,
      outcome: {
        status: 'committed',
        result: effects.result,
        recordVersions: recordVersionsOf(effects.writes),
      },
      committedRevision: (call.revision + 1) as Revision,
      createdAt: now,
    };
    try {
      await input.store.commit({
        expectedRevision: call.revision,
        writes: effects.writes,
        history: effects.history,
        receipt,
        outbox: effects.outbox,
        schedules: effects.schedules,
        uniqueClaims: effects.uniqueClaims,
        uniqueReleases: effects.uniqueReleases,
      });
    } catch (error) {
      if (error instanceof FenceConflictError) continue;
      throw storageToStateError(error);
    }
    return {
      status: 'committed',
      operation_id: input.envelope.operation_id,
      result: effects.result,
      deliveries: effects.outbox.map(
        (intent): DeliveryReceipt => ({ id: intent.intentId, status: 'pending' }),
      ),
    };
  }
  throw new StateError('busy', 'Write contention; retry the identical envelope.', null, {
    retryable: true,
  });
}
