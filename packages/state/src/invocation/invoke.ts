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
  AuthorizedRecordsResult,
  CommitBatch,
  DomainWrite,
  HistoryEntry,
  ModelName,
  Membership,
  OperationName,
  OutboxIntent,
  Receipt,
  RecordId,
  RecordVersion,
  Revision,
  ScheduleOp,
  StoragePort,
  StoredRow,
  UniqueClaim,
  UniqueRelease,
} from '@canlang/contracts';
import type {
  DeliveryReceipt,
  MutationEnvelope,
  MutationResult,
  ReadEnvelope,
} from '@canlang/contracts';
import type { ResolvedIdentity } from '@canlang/contracts';
import type { FanoutChildId } from '@canlang/contracts';
import type { ClosedInputs } from '@canlang/contracts';
import type { GeneratedOperationDef, OperationRegistry } from './registry.js';
import { isGeneratedOperationDef } from './registry.js';
import type { MembershipReader } from '../policy/roles.js';
import { evaluateBy } from '../policy/roles.js';
import type { PolicyTable } from '../policy/grants.js';
import {
  admit,
  receiptIdentityFor,
  revalidateCommitForFence,
  validateCallInputs,
  loadCallRecordRefs,
  openFenceScope,
  type AdmittedCall,
  type ConflictServerOnly,
  type GuardRevalidation,
} from './admission.js';
import { queryRecords, type ViewerRecordsInput } from '../query/index.js';
import { buildContext, type ClockPort } from './context.js';
import { StateError, storageToStateError } from '../errors.js';
import { stageEffectsStaging } from '../effects/staging.js';
import { checkFanoutChildId } from '../fanout/cohort.js';
import { FenceConflictError, StorageConstraintError } from '../storage/port.js';

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
  /**
   * T32b-wire: guard predicates the fenced commit re-evaluates live against
   * CURRENT state (after the revision assertion, before the commit). Offered
   * by executors whose business predicates read NON-fenced state (membership
   * roles, external facts) — anything row-derived is already covered by the
   * revision assertion, which voids on any intervening write. A guard that
   * flips voids the commit with `forbidden` naming the guard. Absent (the
   * CRUD executors offer none yet) reads as no guards.
   */
  guards?: GuardRevalidation[];
  /**
   * T32b-wire: readings offered as authorization evidence for the commit's
   * eventual bar. Any eventual-marked reading refuses the commit with
   * `validation` — display-only reads never authorize. Absent reads as no
   * offered readings.
   */
  readings?: unknown[];
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
 * T32b-wire: commit-time revalidation runs under the faithful identity.
 * The mechanism's explicit revocation check is by-aware (see
 * `byRequiresCallerMembership`): it fires only for gates whose authority
 * flows from the caller's own membership row, so gates that can authorize
 * without caller membership (`public`, `authenticated`, `or` with a
 * membership-free branch, `not`, subject-gated) never false-void — and the
 * live `evaluateBy` re-check still voids genuinely lost permission for
 * every gate. (An earlier `by`-projection for `public`/`authenticated`
 * was subsumed by the by-aware gate and removed.)
 */
function fenceRevalidationIdentity(
  context: { readonly actor?: { readonly userId: string } | null; readonly team?: { readonly teamId: string } | null },
): { readonly actorUserId: string | null; readonly teamId: string | null } {
  return {
    actorUserId: context.actor?.userId ?? null,
    teamId: context.team?.teamId ?? null,
  };
}

/**
 * Invoke one canonical mutation envelope. Unknown operations are `validation`
 * failures; exhausted fence contention is a retryable `busy`. Generated
 * `read` operations are `validation` failures here — reads execute through
 * `invokeRead` below plus the query port (their registry presence exists so
 * denied reads answer denied-not-unknown at admission). The mutation
 * envelope keeps rejecting reads (T16b pins the query-port pointer; T17b
 * routes assembly reads to `invokeRead`).
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
  /**
   * B2 (Q3): serverOnly exclusions for denial currents, forwarded to
   * `admit` (see `ConflictServerOnly`). The holder (seam/assembly)
   * builds it from the loaded models; absent reads as unknown and
   * stale-ref denials carry metadata-only currents.
   */
  conflictServerOnly?: ConflictServerOnly;
}): Promise<MutationResult> {
  const def = input.registry.get(input.envelope.operation);
  if (def === undefined) {
    throw new StateError('validation', `Unknown operation "${input.envelope.operation}".`);
  }
  if (isGeneratedOperationDef(def) && def.descriptor.kind === 'read') {
    throw new StateError(
      'validation',
      `Read operation "${input.envelope.operation}" cannot run through invoke; ` +
        'reads execute through the query port.',
    );
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
      ...(input.conflictServerOnly !== undefined
        ? { conflictServerOnly: input.conflictServerOnly }
        : {}),
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
    // S5: business rejections commit a rejected receipt (same fence, empty
    // effects) so replays observe the rejection deterministically. The
    // ORIGINAL StateError is rethrown to THIS caller (fields/retryable
    // preserved); replays get code/message only — the receipt shape carries
    // no fields. Non-StateError bugs propagate untouched, never receipted.
    let effects: ExecutionEffects;
    try {
      const raw = await input.execute(call);
      // S6: validate executor-staged outbox/schedules INSIDE the try, so
      // malformed executor output becomes a fenced rejected receipt via the
      // path below — never a crash. crudExecute's empty arrays pass
      // trivially; the commit and deliveries below consume the staged clone.
      const staged = stageEffectsStaging(
        { outbox: raw.outbox, schedules: raw.schedules },
        { operationId: context.operationId },
      );
      effects = { ...raw, outbox: staged.outbox, schedules: staged.schedules };
    } catch (error) {
      if (!(error instanceof StateError)) {
        throw error;
      }
      // T32b-wire REJECTED-RECEIPT FENCE RULE: rejected receipts respect the
      // fence too. A moved revision retries like any contention (the next
      // pass replays or recomputes); but a rejection that itself raced a
      // revocation STILL RECORDS — the business verdict was already decided
      // on admitted authority, revocation voids WRITES, and a rejected
      // receipt carries none (writes/history/outbox/schedules/uniques all
      // empty, so domain writes can never commit here). The ORIGINAL error
      // is rethrown, never the fence's forbidden; replays observe the
      // rejection deterministically. Guards are unknowable on this path
      // (the executor threw before returning any), so only the checkpoint
      // revision plus live `by`/revocation revalidate.
      if (call.checkpoint !== undefined) {
        try {
          await revalidateCommitForFence({
            checkpoint: call.checkpoint,
            by: call.def.by,
            guards: [],
            ...fenceRevalidationIdentity(context),
            kind: context.kind,
            store: input.store,
            memberships: input.memberships,
          });
        } catch (fenceError) {
          if (fenceError instanceof StateError && fenceError.code === 'conflict') {
            continue;
          }
          if (!(fenceError instanceof StateError && fenceError.code === 'forbidden')) {
            throw fenceError;
          }
          // Forbidden (revoked mid-flight): fall through and record the
          // rejection — the rule above. No domain writes can commit here.
        }
      }
      const rejected: Receipt = {
        identity: receiptIdentityFor(context),
        inputHash: call.inputHash,
        resolvedDefaults: {},
        outcome: { status: 'rejected', code: error.code, message: error.message },
        committedRevision: (call.revision + 1) as Revision,
        createdAt: now,
      };
      try {
        await input.store.commit({
          expectedRevision: call.revision,
          writes: [],
          history: [],
          receipt: rejected,
          outbox: [],
          schedules: [],
          uniqueClaims: [],
          uniqueReleases: [],
        });
      } catch (commitError) {
        // Lost the fence or the receipt already landed: retry like any
        // contention (consuming an attempt); the next pass replays or
        // recomputes. Any other storage failure is the operative fact, so
        // the original rejection is dropped in favor of reporting it.
        if (commitError instanceof FenceConflictError) {
          continue;
        }
        if (
          commitError instanceof StorageConstraintError &&
          commitError.kind === 'receipt_reuse'
        ) {
          continue;
        }
        throw storageToStateError(commitError);
      }
      throw error;
    }
    // T32b-wire: commit-time fence revalidation between execute and commit
    // (checkpoint from admission, `by` + executor guards re-read live, trusted
    // skips step 3 exactly like admission — the mechanism owns that rule). A
    // moved checkpoint retries like any fence contention (consuming an
    // attempt; the next pass re-admits from scratch); a voided commit
    // (revoked authority, flipped guard, eventual evidence) throws with
    // NOTHING committed and no receipt recorded, so a later retry with a new
    // identity re-admits cleanly. Calls admitted without a checkpoint (older
    // constructed calls) skip revalidation — the commit's expectedRevision
    // fence still applies unconditionally.
    if (call.checkpoint !== undefined) {
      try {
        await revalidateCommitForFence({
          checkpoint: call.checkpoint,
          by: call.def.by,
          guards: effects.guards ?? [],
          ...fenceRevalidationIdentity(context),
          kind: context.kind,
          store: input.store,
          memberships: input.memberships,
          ...(effects.readings !== undefined ? { readings: effects.readings } : {}),
        });
      } catch (fenceError) {
        if (fenceError instanceof StateError && fenceError.code === 'conflict') {
          continue;
        }
        throw fenceError;
      }
    }
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

/** Internal per-call selection using the existing viewer query vocabulary. */
export type ReadSelection = Pick<ViewerRecordsInput, 'where' | 'limit'>;

/** T17a canonical read invocation input: no clock, no executor, no receipts. */
export interface InvokeReadInput {
  readonly registry: OperationRegistry;
  readonly envelope: ReadEnvelope;
  readonly identity: ResolvedIdentity;
  /** Engine-local read grants (T17b transcribes the emitted read rules; T04b formalizes). */
  readonly policy: PolicyTable;
  readonly store: StoragePort;
  readonly memberships: MembershipReader;
  readonly kind?: AdmissionKind;
  readonly trustedSource?: string;
  /** Applied by the viewer query engine only after read admission. */
  readonly selection?: ReadSelection;
}

/**
 * Resolve the served model from the `<Model>.read` emission convention (the
 * compiler publishes one no-input read descriptor per policy-bearing model).
 * A read that names no model cannot serve in the core scope; unlike the
 * create/update/delete twins (whose shapes the loader guarantees, so their
 * execute-time checks are unreachable wiring asserts), the loader admits
 * every read for denied-not-unknown — so a malformed read name is reachable
 * and refuses as caller-safe `validation`, never a crash.
 */
function generatedReadModel(operation: string): ModelName {
  if (!operation.endsWith('.read') || operation.length === '.read'.length) {
    throw new StateError(
      'validation',
      `Operation "${operation}" cannot serve reads in the T17 core scope: ` +
        'readable operations are named <Model>.read.',
    );
  }
  return operation.slice(0, -'.read'.length) as ModelName;
}

/**
 * T17a: invoke one canonical generated read through admission plus the
 * query port. The interim `records()` data-plane operation (direct
 * `StoragePort.query`, owner rows only, no admission) migrates here; T17b
 * routes assembly/stdlib reads to this entry.
 *
 * Routing first (mirroring `invoke`'s pre-admission routing): unknown
 * operations are `validation` failures with `invoke`'s exact message;
 * interim defs and generated non-reads are `validation` failures naming
 * their serving path (the mutation-envelope pointer keeps T16b's `/mutation
 * envelope/` pin servable by delegation); reads that name no model refuse
 * LOUD. Authorization second (mirroring `admit`'s `by` block and
 * `buildContext`'s actor/team mapping verbatim, including the trusted-kind
 * source rule and skip): forged identity contents are ignored — the live
 * membership reader wins both ways. Closed-shape validation third (the ONE
 * shared `validateCallInputs` implementation, so reads and writes reject
 * identical shapes identically). Reads commit nothing, receipt nothing, and
 * report the pre-scan fence revision; a repeated read is byte-identical.
 *
 * Serving rule (fail closed): viewer authority with grant projection only —
 * owner bypass stays engine-internal (T32 owns authority fences). Archived
 * rows are excluded. Core-scope reads carry NO descriptor inputs and serve
 * the whole visible model unless an internal selection is supplied; a read
 * WITH descriptor inputs validates closed and then refuses LOUD — T04a
 * carries no filter vocabulary, so serving
 * would silently mis-filter (T04b carries filter inputs). A policy miss
 * serves empty records (the engine's fail-closed rule — no invented error).
 * The def's engine-local `when`, when present, is ignored exactly like
 * creates (candidate preconditions gate update/delete only).
 */
export async function invokeRead(input: InvokeReadInput): Promise<AuthorizedRecordsResult> {
  const def = input.registry.get(input.envelope.operation);
  if (def === undefined) {
    throw new StateError('validation', `Unknown operation "${input.envelope.operation}".`);
  }
  if (!isGeneratedOperationDef(def)) {
    throw new StateError(
      'validation',
      `Operation "${input.envelope.operation}" cannot run through invokeRead; ` +
        'invokeRead serves generated read operations only.',
    );
  }
  if (def.descriptor.kind !== 'read') {
    throw new StateError(
      'validation',
      `Operation "${input.envelope.operation}" cannot run through invokeRead; ` +
        'mutations execute through the mutation envelope.',
    );
  }
  const model = generatedReadModel(input.envelope.operation);

  const kind = input.kind ?? 'user';
  if (kind === 'trusted' && (input.trustedSource === undefined || input.trustedSource === '')) {
    throw new StateError('validation', 'Trusted invocations require a verified trusted source.');
  }
  const actorUserId =
    kind === 'trusted' || input.identity.actor === null ? null : input.identity.actor.user_id;
  const teamId = input.identity.team === null ? null : input.identity.team.team_id;
  if (kind !== 'trusted') {
    const membership =
      actorUserId !== null && teamId !== null
        ? await input.memberships.findMembership(teamId, actorUserId)
        : null;
    const allowed = await evaluateBy(def.by, {
      actorUserId,
      teamId,
      membership,
      memberships: input.memberships,
    });
    if (!allowed) {
      throw new StateError('forbidden', 'This operation is not permitted for the caller.');
    }
  }

  validateCallInputs(def, input.envelope.inputs);
  if (def.descriptor.inputs.length > 0) {
    throw new StateError(
      'validation',
      `Operation "${input.envelope.operation}" carries read inputs with no T04a serving ` +
        'vocabulary (T04b carries filter inputs); refusing instead of mis-serving.',
    );
  }

  const where = input.selection?.where;
  const limit = input.selection?.limit;
  return queryRecords({
    policy: input.policy,
    model,
    authority: 'viewer',
    context: { actorUserId, teamId },
    memberships: input.memberships,
    store: input.store,
    archived: 'exclude',
    ...(where !== undefined ? { where } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
}

/** Read-only source call: no mutation identity, receipt, or effect staging. */
export interface AdmittedReadScenarioCall {
  readonly def: GeneratedOperationDef;
  readonly inputs: Record<string, unknown>;
  /** Rows contain only the caller's currently granted fields. */
  readonly recordRefs: AdmittedCall['recordRefs'];
  readonly revision: Revision;
  readonly actorUserId: string | null;
  readonly teamId: string | null;
  /** Live identity-store facts; caller-supplied membership claims never enter here. */
  readonly membership: Membership | null;
}

export type ReadScenarioHandler = (call: AdmittedReadScenarioCall) => Promise<unknown>;

export interface InvokeReadScenarioInput extends Omit<InvokeReadInput, 'selection'> {
  readonly execute: ReadScenarioHandler;
}

export interface ReadScenarioResult {
  readonly result: unknown;
  readonly revision: Revision;
}

/**
 * Execute a generated ordinary read scenario at one revision. The source
 * host owns scalar decoding/default evaluation and its declared result codec.
 * State owns closed-shape/ref admission, live authority and viewer projection.
 * Authority reports require a separate source/host contract and do not serve here.
 */
export async function invokeReadScenario(input: InvokeReadScenarioInput): Promise<ReadScenarioResult> {
  const def = input.registry.get(input.envelope.operation);
  if (def === undefined) {
    throw new StateError('validation', `Unknown operation "${input.envelope.operation}".`);
  }
  if (!isGeneratedOperationDef(def) || def.descriptor.kind !== 'read') {
    throw new StateError('validation', 'invokeReadScenario requires a generated read operation.');
  }
  const kind = input.kind ?? 'user';
  if (kind === 'trusted' && (input.trustedSource === undefined || input.trustedSource === '')) {
    throw new StateError('validation', 'Trusted invocations require a verified trusted source.');
  }
  const actorUserId = kind === 'trusted' || input.identity.actor === null
    ? null : input.identity.actor.user_id;
  const teamId = input.identity.team?.team_id ?? null;
  // Enclose every live membership/ref read and the source's query reads.
  const revision = await input.store.readRevision();
  const fence = openFenceScope(revision, teamId ?? 'app');
  const readMembership = () => actorUserId !== null && teamId !== null
    ? input.memberships.findMembership(teamId, actorUserId) : Promise.resolve(null);
  const authorize = async (membership: Membership | null): Promise<void> => {
    if (kind !== 'trusted' && !(await evaluateBy(def.by, {
      actorUserId, teamId, membership, memberships: input.memberships,
    }))) {
      throw new StateError('forbidden', 'This operation is not permitted for the caller.');
    }
  };
  const membership = structuredClone(await readMembership());
  await authorize(membership);
  const validated = validateCallInputs(def, input.envelope.inputs);
  const projectRef = async (
    ref: Pick<AdmittedCall['recordRefs'][number], 'model' | 'id'>,
    row: StoredRow,
  ): Promise<StoredRow> => {
    const visible = await queryRecords({
      policy: input.policy, model: ref.model, authority: 'viewer',
      context: { actorUserId, teamId }, memberships: input.memberships,
      store: input.store, archived: 'include', fence,
      where: { op: 'eq', field: 'id', value: ref.id },
    });
    const record = visible.records.find((candidate) => candidate.id === ref.id);
    if (record === undefined) throw new StateError('not_found', 'Record not found.');
    return { ...row, data: record.data };
  };
  // Visibility precedes stale/archive facts; visible refs keep canonical order.
  const loadedRefs = await loadCallRecordRefs({
    pending: validated.refs, inputs: validated.normalized, store: input.store,
    scope: fence, projectRow: projectRef,
  });
  const recordRefs = loadedRefs.map((ref) => ({ ...ref, row: structuredClone(ref.row) }));
  const projections = loadedRefs.map((ref) => JSON.stringify(ref.row.data));
  // Capture authority/projection evidence separately from mutable host inputs.
  const membershipSnapshot = JSON.stringify(membership);
  const result = await input.execute({
    def, inputs: validated.normalized, recordRefs, revision,
    actorUserId, teamId, membership,
  });
  const assertRevision = async (): Promise<void> => {
    if (await input.store.readRevision() !== revision) {
      throw new StateError('conflict', 'State changed during the read scenario.');
    }
  };
  await assertRevision();
  const live = await readMembership();
  await authorize(live);
  if (JSON.stringify(live) !== membershipSnapshot) {
    throw new StateError('forbidden', 'Caller authority changed during the read scenario.');
  }
  for (const [index, ref] of loadedRefs.entries()) {
    const current = await projectRef(ref, ref.row);
    if (JSON.stringify(current.data) !== projections[index]) {
      throw new StateError('forbidden', 'Record read authority changed during the read scenario.');
    }
  }
  await assertRevision();
  return { result, revision };
}

/* -- T34-F5 fanout child admission (ADDITIVE; `invoke`/`invokeRead` untouched). -- */

/** One fanout child invocation through canonical admission. */
export interface FanoutChildInvokeInput {
  readonly registry: OperationRegistry;
  readonly store: StoragePort;
  readonly memberships: MembershipReader;
  readonly clock: ClockPort;
  /** Scenario child operation (its registry def carries the real `by` gate). */
  readonly childOperation: string;
  /** Stable child identity (parent occurrence + handler + record). */
  readonly child: FanoutChildId;
  /**
   * FRESH uuidv7 attempt identity, caller-minted per attempt.
   * Attempt-scoped only: stable child idempotency rides the F2 child
   * row (claim replays terminal children without invoking), because
   * operation identities must be fresh uuidv7 by construction.
   */
  readonly operationId: string;
  /**
   * The source's VERIFIED identity, forwarded verbatim. Forged contents
   * are ignored — the live membership reader wins both ways — so
   * cohort membership grants no authority: the def's `by` plus live
   * membership decide, per child, at admission AND at commit time.
   */
  readonly identity: ResolvedIdentity;
  /** Selected deployment app; part of the receipt identity. */
  readonly app: string;
  readonly source: string;
  /** Child body inputs (including the child record ref). */
  readonly inputs: ClosedInputs;
  readonly kind?: AdmissionKind;
  readonly trustedSource?: string;
  /** Child body: evaluates filters/guards and stages child effects. */
  readonly execute: ExecuteHandler;
  /**
   * Injected child-unit linkage assertion (the child-join port's
   * `assertFanoutChildJoin`), run over the commit batch before it
   * touches the store. Injected — not imported — so this module keeps
   * its one-way edge into the ports layer (ports/transact imports
   * invocation/invoke; the reverse edge would cycle).
   */
  readonly assertJoin: (batch: CommitBatch) => void;
}

/**
 * Admit one fanout child through the CANONICAL `invoke` path with fresh
 * authority (adopted T32 fence per child):
 *
 * - Fresh admission per child: every call reads a new revision, opens a
 *   new fence scope, re-reads live membership, and revalidates at commit
 *   time. No checkpoint, grant, or version is ever carried from the
 *   source occurrence or a sibling — carrying is structurally
 *   unrepresentable (this helper calls `invoke`, which always admits
 *   fresh).
 * - Membership grants NO authority (§C4): there is no grant input here
 *   at all. A frozen member without a live grant is denied `forbidden`
 *   exactly like any unauthorized caller; revocation between siblings
 *   voids only the revoked child.
 * - Atomic child unit (§C5): the body's staged fanout writes (terminal
 *   outcome + checkpoint advance) commit in the same owner transaction
 *   as the child's domain/history/replay/outbox/schedule effects, with
 *   the injected linkage assertion wrapped around the commit.
 * - Duplicate attempt delivery replays the attempt receipt; duplicate
 *   CHILD delivery replays at the F3 claim (terminal child rows never
 *   re-invoke) — the driver checks the child row before calling here.
 */
export async function invokeFanoutChild(input: FanoutChildInvokeInput): Promise<MutationResult> {
  checkFanoutChildId(input.child);
  const store: StoragePort = {
    ...input.store,
    commit: async (batch) => {
      input.assertJoin(batch);
      return input.store.commit(batch);
    },
  };
  return invoke({
    registry: input.registry,
    store,
    memberships: input.memberships,
    clock: input.clock,
    envelope: {
      operation: input.childOperation,
      operation_id: input.operationId,
      inputs: input.inputs,
    },
    identity: input.identity,
    app: input.app,
    source: input.source,
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.trustedSource !== undefined ? { trustedSource: input.trustedSource } : {}),
    execute: input.execute,
  });
}
