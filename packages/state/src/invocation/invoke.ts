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

import type { AdmissionKind, AuthorizedRecordsResult, CanonicalModelDescriptor, CommitBatch, DomainWrite, HistoryEntry, ModelName, Membership, MutationAdmissionMode, OperationName, OrderTerm, OutboxIntent, QueryPredicate, Receipt, ReceiptOutcome, RecordId, RecordParent, RecordVersion, Revision, ScheduleOp, StoragePort, StoredRow, UniqueClaim, UniqueRelease } from '@canlang/contracts';
import { MAX_MEMBERSHIP_SNAPSHOT_USERS } from '@canlang/contracts';
import type { DeliveryReceipt, MutationEnvelope, MutationResult, ReadEnvelope } from '@canlang/contracts';
import type { ResolvedIdentity } from '@canlang/contracts';
import type { FanoutChildId } from '@canlang/contracts';
import type { ClosedInputs } from '@canlang/contracts';
import type { GeneratedOperationDef, OperationRegistry } from './registry.js';
import { isGeneratedOperationDef } from './registry.js';
import type { ByPredicate, MembershipReader } from '../policy/roles.js';
import { byDependsOnRow, evaluateBy } from '../policy/roles.js';
import { checkedAuthoritySnapshot, checkedMembershipFact, observeRowGrantAuthority } from '../policy/membership-facts.js';
import type { PolicyTable } from '../policy/grants.js';
import { admit, assertOwnerReceiptAdmission, receiptIdentityFor, revalidateCommitForFence, validateCallInputs, loadCallRecordRefs, openFenceScope, type AdmittedCall, type ConflictServerOnly, type GuardRevalidation, type FenceScope } from './admission.js';
import { queryRecords, type ViewerRecordsInput } from '../query/index.js';
import { projectCurrentRecordForViewerPolicy, queryRecordsPageWithParentPolicies, viewerPageOrder, viewerPagePredicateTuple, viewerPageSearchTuple, queryArchiveMode, VIEWER_PAGE_DEFAULT_LIMIT, VIEWER_PAGE_MAX_CANDIDATES, type ViewerPageRecordsResult, type ViewerPageSelection, type ViewerPageTuple, type ViewerPageParentPolicy } from '../query/engine.js';
import type { InterimContainment } from '../mutation/models.js';
import { captureSourceReadPolicies, type ViewerSourceReadPolicy } from '../query/source-policy.js';
import type { InstalledSourceQueryPredicate } from '../receipt/read-policy-membership.js';
import { buildContext, type ClockPort } from './context.js';
import { StateError, storageToStateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { stageEffectsStaging } from '../effects/staging.js';
import { checkFanoutChildId } from '../fanout/cohort.js';
import { FenceConflictError, StorageConstraintError } from '../storage/port.js';
import { hasScenarioExecutionPlan, beginScenarioReceiptExecution, closeScenarioReceiptExecution, retainScenarioReceipt, snapshotScenarioReceiptEffects, revalidateScenarioReceiptCalls } from './scenario-receipt.js';
import { type GeneratedCrudReceiptAssociation } from "./crud-receipt.js";
export { type GeneratedCrudReceiptAssociation, readGeneratedCrudAssociation, type ProjectGeneratedCrudReceiptInput, projectGeneratedCrudReceipt } from "./crud-receipt.js";


/** Fenced-commit attempts per invocation, per DESIGN §7. */
export const MAX_ADMISSION_ATTEMPTS = 3;

export type CommittedReceiptOutcome = Extract<ReceiptOutcome, { status: 'committed' }> & {
  readonly generatedCrud?: GeneratedCrudReceiptAssociation;
};

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
  /** Exact final owning fields; genuine File facts are captured privately
   * during execution and cannot be supplied by this executor carrier. */
  fileAssignments?: readonly unknown[];
  generatedCrud?: GeneratedCrudReceiptAssociation;
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

// Only actual invoke execution opens this lifetime. Admission objects and
// structural copies cannot activate it through an exported constructor.
const activeAdmittedExecutions = new WeakSet<AdmittedCall>();
const scenarioExecutions = new WeakMap<AdmittedCall, {
  readonly store: StoragePort; readonly def: AdmittedCall['def'];
  readonly context: AdmittedCall['context']; readonly revision: Revision;
  readonly contextSnapshot: AdmittedCall['context']; readonly checkpointSnapshot: AdmittedCall['checkpoint'];
  readonly inputs: AdmittedCall['inputs']; readonly inputsSnapshot: AdmittedCall['inputs'];
  readonly recordRefs: AdmittedCall['recordRefs']; readonly recordRefsSnapshot: AdmittedCall['recordRefs'];
  readonly inputHash: string;
  verified: { readonly context: unknown; readonly checkpoint: unknown; readonly inputs: unknown; readonly recordRefs: unknown } | null;
}>();

/** Stabilizes one admitted execution scope for the assertion witness below.
 * The deep admission compares stay meaningful only while the live scope
 * cannot change under them: accessors, cycles-through-getters or exotic
 * states refuse loudly here, and everything else freezes, so a later
 * same-reference observation is provably identical to its passing check.
 * Functions are compared by identity and need no traversal. */
function freezeExecutionScope(value: unknown, seen: Set<object> = new Set()): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const member = Object.getOwnPropertyDescriptor(value, key);
    if (member === undefined || !('value' in member)) {
      throw new StateError('validation', 'Scenario admission requires immutable own-data execution scope.');
    }
    freezeExecutionScope(member.value, seen);
  }
  deepFreeze(value);
}

/** Keep the accepted plain/null own-data prototypes. structuredClone erases
 * null prototypes, which would make an unchanged admitted value look stale.
 */
function snapshotExecutionInputs<T>(value: T): T {
  const seen = new Set<object>();
  const copy = (part: unknown): unknown => {
    if (typeof part !== 'object' || part === null) return part;
    const prototype = Object.getPrototypeOf(part);
    if (seen.has(part) || (!Array.isArray(part) && prototype !== Object.prototype && prototype !== null)) {
      throw new StateError('validation', 'Scenario admission requires acyclic own-data inputs and references.');
    }
    seen.add(part);
    const out = Array.isArray(part) ? [] : Object.create(prototype);
    if (Array.isArray(part)) Object.setPrototypeOf(out, prototype);
    for (const key of Reflect.ownKeys(part)) {
      const member = Object.getOwnPropertyDescriptor(part, key);
      if (member === undefined || !('value' in member)) {
        throw new StateError('validation', 'Scenario admission cannot snapshot an input or reference accessor.');
      }
      if (Array.isArray(part) && key === 'length') { out.length = member.value; continue; }
      Object.defineProperty(out, key, { value: copy(member.value), enumerable: member.enumerable === true, configurable: true });
    }
    seen.delete(part); return out;
  };
  return copy(value) as T;
}

function sameExecutionData(value: unknown, saved: unknown): boolean {
  if (typeof saved !== 'object' || saved === null) return Object.is(value, saved);
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.getPrototypeOf(saved)) return false;
  const keys = Reflect.ownKeys(saved);
  if (Reflect.ownKeys(value).length !== keys.length) return false;
  return keys.every(key => {
    const current = Object.getOwnPropertyDescriptor(value, key), original = Object.getOwnPropertyDescriptor(saved, key);
    return current !== undefined && 'value' in current && original !== undefined && 'value' in original &&
      current.enumerable === original.enumerable &&
      sameExecutionData(current.value, original.value);
  });
}

/** Actual public or trusted invoke lifetime; copies and request data cannot open it. */
export function assertScenarioReceiptExecution(call: AdmittedCall, store: StoragePort): void {
  const active = scenarioExecutions.get(call);
  const member = (key: keyof AdmittedCall): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(call, key);
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  };
  const live = { context: member('context'), checkpoint: member('checkpoint'), inputs: member('inputs'), recordRefs: member('recordRefs') };
  if (!activeAdmittedExecutions.has(call) || active === undefined || active.store !== store ||
      active.def !== member('def') || active.context !== live.context || active.revision !== member('revision') || member('replay') !== null) {
    throw new StateError('forbidden', 'Scenario observation requires its active admitted invocation and owning store.');
  }
  // Same-reference observations repeat an already-passing deep check: the
  // registration freeze below makes live scope contents unchangeable, so only
  // a changed reference can change the verdict, and changed references take
  // the full check. The raw input hash is a mutable string property outside
  // the frozen scope, so it is identity-checked on every fast path too; any
  // mismatch falls through to the full check and its exact forbidden error.
  // The cheap identity pins above keep their exact errors.
  const proven = active.verified;
  if (proven !== null && proven.context === live.context && proven.checkpoint === live.checkpoint &&
      proven.inputs === live.inputs && proven.recordRefs === live.recordRefs &&
      active.inputHash === member('inputHash')) return;
  if (!sameExecutionData(live.context, active.contextSnapshot) || !sameExecutionData(live.checkpoint, active.checkpointSnapshot) ||
      active.inputs !== live.inputs || active.recordRefs !== live.recordRefs || active.inputHash !== member('inputHash') ||
      !sameExecutionData(live.inputs, active.inputsSnapshot) || !sameExecutionData(live.recordRefs, active.recordRefsSnapshot)) {
    throw new StateError('forbidden', 'Scenario observation requires unchanged admitted scope, checkpoint, inputs, references and raw hash.');
  }
  active.verified = live;
}

/** Internal call admission uses Invoke's real Identity reader, never a host
 * replacement supplied with an authored call or a fabricated context. */
export function scenarioReceiptMemberships(call: AdmittedCall, store: StoragePort): MembershipReader {
  assertScenarioReceiptExecution(call, store);
  return scenarioExecutionMemberships.get(call)!;
}
const scenarioExecutionMemberships = new WeakMap<AdmittedCall, MembershipReader>();

interface OwnerMembershipLedger {
  readonly observations: Map<string, boolean>;
  pending: boolean;
  failed: boolean;
  failure: unknown;
}
const ownerMembershipLedgers = new WeakMap<AdmittedCall, OwnerMembershipLedger>();

/** Genuine trusted owner execution only. Source adapters still authenticate
 * their original occurrence inventory; this capability supplies current facts
 * and mandatory commit revalidation, never a receipt or DATA/query authority. */
export function openTrustedOwnerMembershipObservation(call: AdmittedCall): {
  readonly activeMember: (person: string) => Promise<boolean>;
  readonly assertActive: () => void;
  readonly close: () => void;
} {
  const store = scenarioExecutions.get(call)?.store;
  if (store === undefined) throw new StateError('forbidden', 'Owner membership requires its actual active State invocation.');
  assertScenarioReceiptExecution(call, store);
  if (call.checkpoint === undefined || call.context.team === null || ownerMembershipLedgers.has(call)) {
    throw new StateError('forbidden', 'Owner membership requires one actual admitted Team execution.');
  }
  assertOwnerReceiptAdmission(call, store, openFenceScope(call.revision, call.checkpoint.owner));
  const team = call.context.team.teamId;
  const reader = scenarioReceiptMemberships(call, store);
  const ledger: OwnerMembershipLedger = { observations: new Map(), pending: false, failed: false, failure: undefined };
  ownerMembershipLedgers.set(call, ledger);
  let active = true;
  const healthy = (): void => {
    if (ledger.failed) throw ledger.failure;
    assertScenarioReceiptExecution(call, store);
    if (!active || ownerMembershipLedgers.get(call) !== ledger || call.context.team?.teamId !== team) {
      throw new StateError('forbidden', 'Owner membership lost its exact live admitted execution.');
    }
  };
  return Object.freeze({ assertActive: healthy, activeMember: async (person: string): Promise<boolean> => {
    let acquired = false;
    try {
      healthy();
      if (ledger.pending || typeof person !== 'string' || person.length === 0 || person.length > 4096 ||
          !ledger.observations.has(person) && ledger.observations.size >= MAX_MEMBERSHIP_SNAPSHOT_USERS) {
        throw new StateError('validation', 'Owner membership requires bounded sequential current person observations.');
      }
      ledger.pending = true; acquired = true;
      if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Owner membership checkpoint moved.');
      healthy();
      const fact = checkedMembershipFact(await reader.findMembership(team, person), team, person);
      healthy();
      if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Owner membership read crossed its checkpoint.');
      healthy();
      const result = fact !== null && fact.status === 'active';
      if (ledger.observations.has(person) && ledger.observations.get(person) !== result) {
        throw new StateError(ledger.observations.get(person) === false ? 'conflict' : 'forbidden', 'Owner membership changed during its original source execution.');
      }
      ledger.observations.set(person, result);
      return result;
    } catch (error) {
      if (!ledger.failed) { ledger.failed = true; ledger.failure = error; }
      throw ledger.failure;
    } finally { if (acquired) ledger.pending = false; }
  }, close: () => { active = false; } });
}

function assertOwnerMembershipComplete(call: AdmittedCall): void {
  const ledger = ownerMembershipLedgers.get(call);
  if (ledger?.failed) throw ledger.failure;
  if (ledger?.pending) throw new StateError('validation', 'Owner membership cannot outlive its awaited source execution.');
}

async function revalidateOwnerMembership(call: AdmittedCall, store: StoragePort, reader: MembershipReader): Promise<void> {
  assertOwnerMembershipComplete(call);
  const ledger = ownerMembershipLedgers.get(call);
  if (ledger === undefined) return;
  const team = call.context.team?.teamId;
  if (team === undefined) throw new StateError('forbidden', 'Owner membership lost its original Team.');
  for (const [person, expected] of ledger.observations) {
    if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Owner membership moved before commit.');
    const fact = checkedMembershipFact(await reader.findMembership(team, person), team, person);
    if ((fact !== null && fact.status === 'active') !== expected) throw new StateError(expected ? 'forbidden' : 'conflict', 'Owner membership changed before commit.');
    if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Owner membership recheck crossed its checkpoint.');
  }
}

/** Internal receipt join assertion; checking cannot activate an execution. */
export function assertOwnerReceiptExecution(
  call: AdmittedCall, store: StoragePort, fence: FenceScope,
): void {
  if (!activeAdmittedExecutions.has(call)) {
    throw new StateError('forbidden', 'Owner receipt observation requires the active trusted owner execution.');
  }
  assertOwnerReceiptAdmission(call, store, fence);
}

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
export interface InvokeMutationInput {
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
   * R10 host-only pre-commit preparation. The State mechanism runs this
   * after the executor returns and BEFORE the final fence revalidation
   * (revision, live by/Identity, guards), so asynchronous host verification
   * cannot open an authority window after the last authority check. A
   * throw voids the commit with nothing stored, exactly like a flipped
   * guard. Must be side-effect-free with respect to domain state; the
   * mechanism owns all authority checks and still runs them in full after
   * this preparation completes. Absent reads as none (existing behavior).
   */
  prepareForCommit?: () => Promise<void>;
  /** Host-only admission selection; omitted keeps ordinary mutation admission. */
  admissionMode?: MutationAdmissionMode;
  /** Synchronous observation after durability; failures never retry execution. */
  observeCommittedReceipt?: (receipt: Receipt & { readonly outcome: CommittedReceiptOutcome }) => void;
  /** Trusted synchronous observation only after a rejected receipt is durable or exactly replayed. */
  observeRejectedReceipt?: (receipt: Receipt) => void;
  /**
   * B2 (Q3): serverOnly exclusions for denial currents, forwarded to
   * `admit` (see `ConflictServerOnly`). The holder (seam/assembly)
   * builds it from the loaded models; absent reads as unknown and
   * stale-ref denials carry metadata-only currents.
   */
  conflictServerOnly?: ConflictServerOnly;
}

/**
 * Positive installed-support boundary for recovery. Hosts must require this
 * export before restoring a retained call; older invokers may ignore an
 * optional mode. This entry always selects receipt-only admission, including
 * when an untyped caller supplies a conflicting mode. Disclosure still uses
 * the owning current-access projection after this internal invocation.
 */
export function invokeRetainedReceiptOnly(
  input: Omit<InvokeMutationInput, 'admissionMode'>,
): Promise<MutationResult> {
  return invoke({ ...input, admissionMode: 'retained-receipt-only' });
}

export async function invoke(input: InvokeMutationInput): Promise<MutationResult> {
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
      ...(input.admissionMode === undefined ? {} : { admissionMode: input.admissionMode }),
      ...(input.conflictServerOnly !== undefined
        ? { conflictServerOnly: input.conflictServerOnly }
        : {}),
    });
    // Receipt identity always retains the original raw admission hash, even
    // when caught executor drift is subsequently recorded as a rejection.
    const admittedInputHash = call.inputHash;
    if (call.replay !== null) {
      const outcome = call.replay.outcome;
      if (outcome.status === 'rejected') {
        input.observeRejectedReceipt?.(call.replay);
        throw new StateError(outcome.code, outcome.message);
      }
      input.observeCommittedReceipt?.({ ...call.replay, outcome });
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
    let effects: ExecutionEffects & { scenario?: import('@canlang/contracts').ScenarioReceiptAssociation };
    try {
      let raw: ExecutionEffects;
      activeAdmittedExecutions.add(call);
      scenarioExecutionMemberships.set(call, input.memberships);
      try {
        const claimed = isGeneratedOperationDef(def) && (def.descriptor.result?.disclosure !== undefined || hasScenarioExecutionPlan(def));
        // Stabilize the live scope once: later same-reference assertions then
        // repeat a passing check without re-walking it. Context, checkpoint
        // and record references are engine-built, so they freeze in place.
        // Admitted inputs may alias caller memory (interim operations keep
        // the caller's inputs object), so inputs move to a privately owned
        // frozen copy: the caller keeps full write access to their object
        // while the engine observes only immutable admission data. Changed
        // live references always take the full check in the assertion above.
        // Any engine-side scope mutation throws here instead of passing silently.
        call.inputs = deepFreeze(snapshotExecutionInputs(call.inputs));
        freezeExecutionScope(call.context);
        freezeExecutionScope(call.checkpoint);
        freezeExecutionScope(call.recordRefs);
        scenarioExecutions.set(call, { store: input.store, def: call.def, context: call.context, revision: call.revision,
          contextSnapshot: structuredClone(call.context), checkpointSnapshot: structuredClone(call.checkpoint),
          inputs: call.inputs, inputsSnapshot: claimed ? snapshotExecutionInputs(call.inputs) : structuredClone(call.inputs),
          recordRefs: call.recordRefs, recordRefsSnapshot: claimed ? snapshotExecutionInputs(call.recordRefs) : structuredClone(call.recordRefs),
          inputHash: call.inputHash, verified: null });
        beginScenarioReceiptExecution(call, input.store);
        raw = await input.execute(call);
        if (ownerMembershipLedgers.has(call)) assertScenarioReceiptExecution(call, input.store);
        assertOwnerMembershipComplete(call);
        if (isGeneratedOperationDef(def) && (def.descriptor.result?.disclosure !== undefined || hasScenarioExecutionPlan(def))) {
          assertScenarioReceiptExecution(call, input.store);
        }
        raw = snapshotScenarioReceiptEffects(call, raw);
      } finally {
        closeScenarioReceiptExecution(call);
        activeAdmittedExecutions.delete(call);
        scenarioExecutions.delete(call);
        scenarioExecutionMemberships.delete(call);
      }
      // S6: validate executor-staged outbox/schedules INSIDE the try, so
      // malformed executor output becomes a fenced rejected receipt via the
      // path below — never a crash. crudExecute's empty arrays pass
      // trivially; the commit and deliveries below consume the staged clone.
      const staged = stageEffectsStaging(
        { outbox: raw.outbox, schedules: raw.schedules },
        { operationId: context.operationId },
      );
      // Association comes only from the active capture, never executor output.
      if (Object.hasOwn(raw, 'scenario')) throw new StateError('validation', 'Executor cannot supply a saved scenario association.');
      const scenario = retainScenarioReceipt(call, raw);
      effects = { ...raw, outbox: staged.outbox, schedules: staged.schedules,
        ...(scenario === undefined ? {} : { scenario }) };
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
      //
      // R10: the same host preparation as the success fence runs before the
      // rejection's final revision/by/Identity sequence, so an executor that
      // hit staged-file/closure drift cannot persist its rejection under a
      // no-longer-current installed closure. This runs even for calls
      // admitted without a checkpoint (which skip authority revalidation
      // below): preparation is source verification, not authority
      // revalidation, and the commit's expectedRevision fence still applies.
      // A preparation throw escapes with nothing stored — no rejected receipt
      // — exactly like the success path, and never enters the forbidden catch
      // below (only a genuine revalidation `forbidden` records).
      if (input.prepareForCommit !== undefined) await input.prepareForCommit();
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
        inputHash: admittedInputHash,
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
      input.observeRejectedReceipt?.(rejected);
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
        // R10: host preparation (e.g. asynchronous source verification)
        // completes BEFORE the final authority sequence, so no host await
        // can land between the last membership/by check and the commit.
        if (input.prepareForCommit !== undefined) await input.prepareForCommit();
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
        await revalidateScenarioReceiptCalls(call);
        await revalidateOwnerMembership(call, input.store, input.memberships);
      } catch (fenceError) {
        if (fenceError instanceof StateError && fenceError.code === 'conflict') {
          continue;
        }
        throw fenceError;
      }
    }
    const receipt: Receipt & { readonly outcome: CommittedReceiptOutcome } = {
      identity: receiptIdentityFor(context),
      inputHash: admittedInputHash,
      resolvedDefaults: effects.resolvedDefaults,
      outcome: {
        status: 'committed',
        result: effects.result,
        // Saved scenario association is State's exact business-row carrier.
        // Genuine framework rows share the fence, never business disclosure.
        // Complete joined writes remain sealed and committed below.
        recordVersions: effects.scenario === undefined ? recordVersionsOf(effects.writes)
          : effects.scenario.changed.map(({ model, row }) => ({ model, id: row.id, version: row.version })),
        ...(effects.generatedCrud === undefined ? {} : { generatedCrud: effects.generatedCrud }),
        ...(effects.scenario === undefined ? {} : { scenario: effects.scenario }),
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
    input.observeCommittedReceipt?.(receipt);
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

/** Internal host-only selection; predicate functions never come from JSON/user input. */
export type ReadSelection = Pick<ViewerRecordsInput, 'where' | 'order' | 'limit' | 'predicate' | 'archived'>;

/** T17a canonical read invocation input: no clock, no executor, no receipts. */
export interface InvokeReadInput {
  /** Verified installed declarations, never supplied through selection/JSON. */
  readonly sourceReadPolicies?: ReadonlyMap<ModelName, ViewerSourceReadPolicy>;
  readonly registry: OperationRegistry;
  /** Checked owning declarations from trusted host wiring, never ReadSelection. */
  readonly models?: ReadonlyArray<CanonicalModelDescriptor>;
  /** Checked installed child declarations for owner-scoped authority reports. */
  readonly containment?: ReadonlyMap<ModelName, InterimContainment>;
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
 * Outcome 9 family E: checked `scope=authority` report fact (DESIGN
 * §§434/442/522, coordinator ruling AUTHORITY-1). The host binds the
 * compiler-checked fact — the §13 `scope:"authority"` marker plus the
 * verbatim `#` description identifying the information exposed and its
 * checked source origin — onto the loaded generated read def. The binding
 * is engine-local (like `by`/`when` attachments): it carries no authority
 * itself and never derives the fact; an unbound def stays an ordinary
 * viewer read. Until bound, and through every viewer path, authority data
 * refuses instead of serving filtered rows.
 */
export interface AuthorityReportSource {
  readonly path: string;
  readonly sha256: string;
  readonly module: string;
}

export interface AuthorityReportScope {
  /** Verbatim checked `#` description; empty refuses (DESIGN §522). */
  readonly description: string;
  readonly source: AuthorityReportSource;
}

const authorityReportScopes = new WeakMap<GeneratedOperationDef, AuthorityReportScope>();

function authorityText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new StateError('validation', `Authority report scope requires a bounded ${what}.`);
  }
  return value;
}

function authoritySource(value: unknown): AuthorityReportSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== 3) {
    throw new StateError('validation', 'Authority report scope requires closed own source data.');
  }
  const record = value as Record<string, unknown>;
  const path = authorityText(record['path'], 'source path');
  const sha256 = authorityText(record['sha256'], 'source sha256');
  const module = authorityText(record['module'], 'source module');
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new StateError('validation', 'Authority report source requires the checked 64-hex source sha256.');
  }
  return Object.freeze({ path, sha256, module });
}

/** Bind the checked authority-report fact to its loaded generated read def. */
export function bindAuthorityReportScope(def: GeneratedOperationDef, scope: AuthorityReportScope): void {
  if (def.descriptor.kind !== 'read') {
    throw new StateError('validation', 'Authority reports are read operations with a declared result.');
  }
  if (def.descriptor.result === undefined) {
    throw new StateError('validation', 'Authority reports require a declared result type for the grant.');
  }
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(scope)) ||
      Reflect.ownKeys(scope).length !== 2) {
    throw new StateError('validation', 'Authority report scope requires closed own data.');
  }
  const description = authorityText(scope.description, 'description identifying the information exposed');
  if (authorityReportScopes.has(def)) {
    throw new StateError('validation', 'Authority report scope is already bound to this operation.');
  }
  authorityReportScopes.set(def, Object.freeze({ description, source: authoritySource(scope.source) }));
}

/** The bound checked fact, or undefined for ordinary viewer reads. */
export function authorityReportScopeOf(def: GeneratedOperationDef): AuthorityReportScope | undefined {
  return authorityReportScopes.get(def);
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
 * rows are excluded unless the checked selection includes them. Core-scope reads carry NO descriptor inputs and serve
 * the whole visible model unless an internal selection is supplied; a read
 * WITH descriptor inputs validates closed and then refuses LOUD — T04a
 * carries no filter vocabulary, so serving
 * would silently mis-filter (T04b carries filter inputs). A policy miss
 * serves empty records (the engine's fail-closed rule — no invented error).
 * The def's engine-local `when`, when present, is ignored exactly like
 * creates (candidate preconditions gate update/delete only).
 */
export async function invokeRead(input: InvokeReadInput): Promise<AuthorizedRecordsResult> {
  const sourceReadPolicies = input.sourceReadPolicies === undefined ? undefined : captureSourceReadPolicies(input.sourceReadPolicies);
  const predicate = input.selection?.predicate;
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
  // Family E: an authority report never serves through the viewer port. A
  // viewer-mode read of authority data refuses (fail closed) instead of
  // serving filtered rows; the grant serves only through invokeReadScenario.
  if (authorityReportScopeOf(def) !== undefined) {
    throw new StateError(
      'validation',
      `Operation "${input.envelope.operation}" is an authority report; ` +
        'viewer reads cannot serve granted results.',
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

  const selection = input.selection ?? {};
  const where = selection.where;
  const order = selection.order;
  const limit = selection.limit;
  const modelDescriptor = input.models?.find((descriptor) => descriptor.name === model);
  return queryRecords({
    ...(sourceReadPolicies === undefined ? {} : { sourceReadPolicies }),
    policy: input.policy,
    model,
    ...(modelDescriptor !== undefined ? { modelDescriptor } : {}),
    authority: 'viewer',
    context: { actorUserId, teamId },
    memberships: input.memberships,
    store: input.store,
    archived: queryArchiveMode(selection.archived),
    ...(where !== undefined ? { where } : {}),
    ...(order !== undefined ? { order } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(predicate !== undefined ? { predicate } : {}),
  });
}

/** Bounded decision-mode read selection: data-only AST, never callbacks. */
export interface DecisionReadSelection {
  /** Exact owning row for a checked contained-child source query. */
  readonly parent?: RecordParent;
  readonly where?: QueryPredicate;
  readonly order?: ReadonlyArray<OrderTerm>;
  readonly limit?: number;
}

/** Decision-mode rows: full stored rows at the fence revision, never projected. */
export interface DecisionReadResult {
  readonly rows: ReadonlyArray<StoredRow>;
  readonly revision: Revision;
}

/**
 * Outcome 9 family E decision capability (DESIGN §442, AUTHORITY-1):
 * bounded authority state at the resolved storage owner, enrolled in the
 * admitted fence revision. No read policy is applied to these scans and no
 * membership check runs inside them; the capability itself is the admitted
 * authority and exists only on the admitted authority execution. Pure
 * queries only — there is no commit, receipt, or effect surface.
 */
export interface DecisionReadCapability {
  readonly scope: 'authority';
  /** The bound checked description identifying the information exposed. */
  readonly description: string;
  query(model: ModelName, selection?: DecisionReadSelection): Promise<DecisionReadResult>;
  /** Current, fenced Identity observation for a checked authority-report helper. */
  activeMember(person: string): Promise<boolean>;
}

/** Decision scans stay bounded: the default cap matches the page candidate budget; overflow fails, never truncates. */
const AUTHORITY_DECISION_DEFAULT_LIMIT = VIEWER_PAGE_MAX_CANDIDATES;

/** Read-only source call: no mutation identity, receipt, or effect staging. */
export interface AdmittedReadScenarioCall {
  readonly def: GeneratedOperationDef;
  readonly inputs: Record<string, unknown>;
  /** Rows contain only the caller's currently granted fields (full owner rows in decision mode). */
  readonly recordRefs: AdmittedCall['recordRefs'];
  readonly revision: Revision;
  readonly actorUserId: string | null;
  readonly teamId: string | null;
  /** Live identity-store facts; caller-supplied membership claims never enter here. */
  readonly membership: Membership | null;
  /** State-owned current Identity observation; conveys no owner query authority. */
  readonly activeMember: (person: string) => Promise<boolean>;
  /**
   * Present only on admitted authority-report executions. Ordinary read
   * scenario calls omit this member entirely, keeping their exact shape.
   */
  readonly decision?: DecisionReadCapability;
}

export type ReadScenarioHandler<Result = unknown> = (call: AdmittedReadScenarioCall) => Promise<Result>;

export interface InvokeReadScenarioInput<Result = unknown> extends Omit<InvokeReadInput, 'selection'> {
  readonly execute: ReadScenarioHandler<Result>;
}

export interface ReadScenarioResult<Result = unknown> {
  readonly result: Result;
  readonly revision: Revision;
}

/**
 * Execute a generated ordinary read scenario at one revision. The source
 * host owns scalar decoding/default evaluation and its declared result codec.
 * State owns closed-shape/ref admission, live authority and viewer projection.
 * Authority reports require a separate source/host contract and do not serve here.
 */
export async function invokeReadScenario<Result = unknown>(input: InvokeReadScenarioInput<Result>): Promise<ReadScenarioResult<Result>> {
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
  const authorize = async (membership: Membership | null, memberships = input.memberships): Promise<void> => {
    if (kind !== 'trusted' && !(await evaluateBy(def.by, {
      actorUserId, teamId, membership, memberships,
    }))) {
      throw new StateError('forbidden', 'This operation is not permitted for the caller.');
    }
  };
  const membership = structuredClone(await readMembership());
  await authorize(membership);
  // Family E: the bound checked fact selects decision-mode evaluation for
  // this execution. The description recheck is defense in depth beside the
  // compiler E3001 and the bind-time refusal: an undescribed grant refuses.
  const authority = authorityReportScopeOf(def);
  if (authority !== undefined && authority.description === '') {
    throw new StateError('validation', 'Authority reports must have a description identifying the information exposed.');
  }
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
  // Decision mode skips the row-grant observation below entirely: per DESIGN
  // §442 decision scans never recursively apply read policies, so refs load
  // as full owner rows through the shared loader (stale/archive/missing
  // identity retained) without viewer projection.
  let loadedRefs: AdmittedCall['recordRefs'];
  let revalidateRefAuthority: (() => Promise<void>) | undefined;
  if (authority !== undefined) {
    loadedRefs = await loadCallRecordRefs({
      pending: validated.refs, inputs: validated.normalized, store: input.store, scope: fence,
    });
  } else {
  const rowSubjects = validated.refs.some(ref => input.policy.get(ref.model)?.grants.some(grant => byDependsOnRow(grant.by)));
  if (rowSubjects) {
    let discoveredRefs: AdmittedCall['recordRefs'] | undefined;
    const originals = new Map<string, StoredRow>();
    const refKey = (ref: { model: ModelName; id: RecordId }) => JSON.stringify([ref.model, ref.id]);
    const authority = await observeRowGrantAuthority({ actorUserId, teamId, membership, memberships: input.memberships }, async current => {
      if (current.membership === undefined) throw new StateError('validation', 'Viewer grant observation requires its caller membership snapshot.');
      await authorize(current.membership, current.memberships);
      const project = async (ref: Pick<AdmittedCall['recordRefs'][number], 'model' | 'id'>, row: StoredRow): Promise<StoredRow> => {
        const visible = await projectCurrentRecordForViewerPolicy({ policy: input.policy.get(ref.model), context: current, row });
        if (visible.record === null) throw new StateError('not_found', 'Record not found.');
        return { ...row, data: visible.record.data };
      };
      if (discoveredRefs === undefined) {
        discoveredRefs = await loadCallRecordRefs({
          pending: validated.refs, inputs: validated.normalized, store: input.store, scope: fence,
          projectRow: async (ref, row) => { originals.set(refKey(ref), row); return project(ref, row); },
        });
        return discoveredRefs;
      }
      // Snapshot confirmation reevaluates only policy over the original owning
      // rows. The source callback and storage producer are never replayed.
      const confirmed: Array<AdmittedCall['recordRefs'][number]> = [];
      for (const ref of discoveredRefs) confirmed.push({ ...ref, row: await project(ref, originals.get(refKey(ref))!) });
      return confirmed;
    });
    loadedRefs = authority.value;
    revalidateRefAuthority = authority.revalidate;
    if (await input.store.readRevision() !== revision) throw new StateError('conflict', 'State changed during read authority discovery.');
  } else loadedRefs = await loadCallRecordRefs({
    pending: validated.refs, inputs: validated.normalized, store: input.store,
    scope: fence, projectRow: projectRef,
  });
  }
  const recordRefs = loadedRefs.map((ref) => ({ ...ref, row: structuredClone(ref.row) }));
  const projections = loadedRefs.map((ref) => JSON.stringify(ref.row.data));
  // Capture authority/projection evidence separately from mutable host inputs.
  const membershipSnapshot = JSON.stringify(membership);
  // Family E decision reads: owner authority at the fence revision, enrolled
  // in the same fence. Each observation is retained for the post-execution
  // recheck, mirroring the viewer readings below.
  const decisionObservations: Array<{
    readonly model: ModelName; readonly parent?: RecordParent; readonly where?: QueryPredicate;
    readonly order?: ReadonlyArray<OrderTerm>; readonly limit: number; readonly projection: string;
  }> = [];
  const observedMemberships = new Map<string, Membership | null>();
  const runDecisionQuery = async (
    model: ModelName, parent?: RecordParent, where?: QueryPredicate, order?: ReadonlyArray<OrderTerm>, limit?: number,
  ): Promise<DecisionReadResult> => {
    if (parent !== undefined && input.containment?.get(model)?.parent !== parent.model) {
      throw new StateError('validation', 'Authority decision parent differs from its declared child model.');
    }
    const bounded = limit ?? AUTHORITY_DECISION_DEFAULT_LIMIT;
    const modelDescriptor = input.models?.find((descriptor) => descriptor.name === model);
    const served = await queryRecords({
      policy: input.policy, model,
      ...(modelDescriptor !== undefined ? { modelDescriptor } : {}),
      authority: 'owner',
      ...(parent === undefined ? {} : { parent }),
      context: { actorUserId, teamId },
      memberships: input.memberships,
      store: input.store,
      fence,
      archived: 'exclude',
      ...(where !== undefined ? { where } : {}),
      ...(order !== undefined ? { order } : {}),
      limit: bounded,
    });
    if (served.revision !== revision || await input.store.readRevision() !== revision) {
      throw new StateError('conflict', 'State changed during the read scenario query.');
    }
    return { rows: served.rows, revision: served.revision };
  };
  let membershipActive = true;
  let membershipFailed = false;
  let membershipFailure: unknown;
  const assertMembershipActive = (): void => {
    if (membershipFailed) throw membershipFailure;
    if (!membershipActive) throw new StateError('validation', 'Read membership requires its live State execution.');
  };
  const activeMember = async (person: string): Promise<boolean> => {
    try {
      assertMembershipActive();
      if (typeof person !== 'string' || person === '' || person.length > 4096 || teamId === null ||
          observedMemberships.size >= MAX_MEMBERSHIP_SNAPSHOT_USERS && !observedMemberships.has(person)) {
        throw new StateError('validation', 'Read scenario membership needs its bounded current Team and person.');
      }
      const fact = checkedMembershipFact(await input.memberships.findMembership(teamId, person), teamId, person);
      assertMembershipActive();
      if (await input.store.readRevision() !== revision) throw new StateError('conflict', 'State changed during read membership observation.');
      assertMembershipActive();
      const previous = observedMemberships.get(person);
      if (observedMemberships.has(person) && JSON.stringify(previous) !== JSON.stringify(fact)) {
        throw new StateError('forbidden', 'Read membership changed during its source decision.');
      }
      observedMemberships.set(person, fact);
      return fact?.status === 'active';
    } catch (error) {
      if (!membershipFailed) { membershipFailed = true; membershipFailure = error; }
      throw membershipFailure;
    }
  };
  const decision = authority === undefined ? undefined : {
    scope: 'authority' as const,
    description: authority.description,
    query: async (model: ModelName, selection: DecisionReadSelection = {}): Promise<DecisionReadResult> => {
      const observed = await runDecisionQuery(model, selection.parent, selection.where, selection.order, selection.limit);
      decisionObservations.push({
        model, ...(selection.parent === undefined ? {} : { parent: selection.parent }),
        ...(selection.where !== undefined ? { where: selection.where } : {}),
        ...(selection.order !== undefined ? { order: selection.order } : {}),
        limit: selection.limit ?? AUTHORITY_DECISION_DEFAULT_LIMIT,
        projection: JSON.stringify(observed.rows),
      });
      return observed;
    },
    activeMember,
  } satisfies DecisionReadCapability;
  // The typed result serves as the explicit grant to the admitted `by`
  // (DESIGN §522): no viewer projection touches it; the fence, membership,
  // and observation rechecks below void it on any authority change.
  let result: Result;
  try {
    result = await input.execute({
      def, inputs: validated.normalized, recordRefs, revision,
      actorUserId, teamId, membership, activeMember,
      ...(decision === undefined ? {} : { decision }),
    });
    if (membershipFailed) throw membershipFailure;
  } finally { membershipActive = false; }
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
  if (observedMemberships.size > 0) {
    if (teamId === null) throw new StateError('validation', 'Report membership lost its admitted Team.');
    const users = [...observedMemberships.keys()];
    if (users.length === 1) {
      const person = users[0]!;
      const current = checkedMembershipFact(await input.memberships.findMembership(teamId, person), teamId, person);
      if (JSON.stringify(current) !== JSON.stringify(observedMemberships.get(person))) {
        throw new StateError('forbidden', 'Report membership changed during its source decision.');
      }
    } else {
      const snapshot = input.memberships.findMembershipsSnapshot;
      if (typeof snapshot !== 'function') throw new StateError('validation', 'Report membership requires a coherent Identity snapshot.');
      const facts = checkedAuthoritySnapshot(await snapshot.call(input.memberships, teamId, users), teamId, users);
      if (users.some(person => JSON.stringify(facts.get(JSON.stringify([teamId, person]))) !==
          JSON.stringify(observedMemberships.get(person)))) {
        throw new StateError('forbidden', 'Report membership changed during its source decision.');
      }
    }
  }
  if (revalidateRefAuthority !== undefined) await revalidateRefAuthority();
  else if (authority !== undefined) {
    // Decision revalidation: owner rows and decision observations are
    // re-read over the original rows; any drift voids the grant. The fence
    // revision check above already covers committed writes.
    for (const [index, ref] of loadedRefs.entries()) {
      const current = await input.store.load(ref.model, ref.id);
      if (current === null) throw new StateError('not_found', 'Record not found.');
      if (JSON.stringify(current.data) !== projections[index]) {
        throw new StateError('forbidden', 'Record read authority changed during the read scenario.');
      }
    }
    for (const observation of decisionObservations) {
      const fresh = await runDecisionQuery(observation.model, observation.parent,
        observation.where, observation.order, observation.limit);
      if (JSON.stringify(fresh.rows) !== observation.projection) {
        throw new StateError('forbidden', 'Record read authority changed during the read scenario.');
      }
    }
  } else {
    for (const [index, ref] of loadedRefs.entries()) {
      const current = await projectRef(ref, ref.row);
      if (JSON.stringify(current.data) !== projections[index]) {
        throw new StateError('forbidden', 'Record read authority changed during the read scenario.');
      }
    }
  }
  await assertRevision();
  return { result, revision };
}

/** Closed copied query identity, consumed only by the owning host cursor codec. */
type CheckedViewerPageDefinitionPrefix = readonly [
  profile: 'viewer-page/v1',
  operation: readonly [ModelName, OperationName, ViewerPageTuple],
  parent: readonly [ModelName, RecordId] | null,
  where: ViewerPageTuple | null,
  order: ReadonlyArray<readonly [string, 'asc' | 'desc']>,
  limit: number,
  candidates: typeof VIEWER_PAGE_MAX_CANDIDATES,
  orderTypes: ReadonlyArray<readonly [string, string | null, boolean | null]>,
  scopes: ReadonlyArray<readonly [ModelName, ViewerPageTuple | null, ViewerPageTuple, ViewerPageTuple | null]>,
];

export type CheckedViewerPageDefinition = readonly [
  ...CheckedViewerPageDefinitionPrefix,
  decisions: readonly [operation: true, childGrants: ReadonlyArray<boolean>,
    parentGrants: ReadonlyArray<readonly [ModelName, true, ReadonlyArray<boolean>]>],
];

export interface ViewerPageResult extends ViewerPageRecordsResult {
  /** Internal policy/type definition; never send this tuple to a viewer. */
  readonly queryDefinition: CheckedViewerPageDefinition;
}

export interface InvokeReadPageInput extends Omit<InvokeReadInput, 'selection' | 'kind' | 'trustedSource'> {
  /** Checked declaration linkage, supplied with the registry by its producer. */
  readonly containment: ReadonlyMap<ModelName, InterimContainment>;
  readonly selection?: ViewerPageSelection;
  /** Trusted generated-source filter over already projected rows. */
  readonly generatedPredicate?: InstalledSourceQueryPredicate;
}

export type ViewerPageTransform<Result> = (page: Readonly<ViewerPageResult>) => Result | Promise<Result>;

function pageByTuple(by: ByPredicate): ViewerPageTuple {
  if (typeof by === 'string') return [by];
  if ('role' in by) return ['role', by.role];
  if ('roleSubject' in by) {
    const person = by.roleSubject.person;
    return ['roleSubject', by.roleSubject.role, typeof person === 'string'
      ? person : ['row-field', person.model, person.field]];
  }
  if ('not' in by) return ['not', pageByTuple(by.not)];
  if ('and' in by) return ['and', by.and.map(pageByTuple)];
  return ['or', by.or.map(pageByTuple)];
}

/**
 * Viewer-only page read. Host digest/signing finishes inside the admitted read;
 * current authority and revision checks follow before any result is returned.
 * The host binds checked query definitions, including current relevant grant
 * decisions, across requests; a changed decision requires a restart.
 */
export function invokeReadPage(input: InvokeReadPageInput): Promise<ViewerPageResult>;
export function invokeReadPage<Result>(input: InvokeReadPageInput, transform: ViewerPageTransform<Result>): Promise<Result>;
export async function invokeReadPage(input: InvokeReadPageInput,
  transform?: ViewerPageTransform<unknown>): Promise<unknown> {
  const sourceReadPolicies = input.sourceReadPolicies === undefined ? undefined : captureSourceReadPolicies(input.sourceReadPolicies);
  const generatedPredicate = input.generatedPredicate;
  // Do not spread the per-call selection before admission/closed input checks.
  let finalizePage: (() => Promise<void>) | undefined;
  const admitted = await invokeReadScenario({
    registry: input.registry, policy: input.policy, store: input.store,
    memberships: input.memberships, envelope: input.envelope, identity: input.identity,
    execute: async call => {
      // Family E: authority grants are single typed results, never viewer
      // page collections. This check precedes model resolution so the
      // refusal names the grant boundary rather than the read convention.
      if (authorityReportScopeOf(call.def) !== undefined) {
        throw new StateError(
          'validation',
          `Operation "${input.envelope.operation}" is an authority report; ` +
            'paged viewer reads cannot serve granted results.',
        );
      }
      const model = generatedReadModel(input.envelope.operation);
      if (call.def.descriptor.inputs.length !== 0) {
        throw new StateError('validation', 'Paged model reads require the supported empty generated input shape.');
      }
      const descriptor = input.models?.find(candidate => candidate.name === model);
      if (descriptor === undefined) {
        throw new StateError('validation', 'Paged reads require the checked owning model declaration.');
      }
      let selection: ViewerPageSelection;
      try { selection = structuredClone(input.selection === undefined ? {} : input.selection); }
      catch { throw new StateError('validation', 'Page selection must be a data-only AST.'); }
      if (typeof selection !== 'object' || selection === null || Array.isArray(selection)) {
        throw new StateError('validation', 'Invalid page selection.');
      }
      if (Object.keys(selection).some(key => !['where', 'order', 'search', 'includeCount', 'limit', 'parent', 'continuation', 'archived'].includes(key))) {
        throw new StateError('validation', 'Unknown page selection field.');
      }
      if (generatedPredicate !== undefined &&
          (typeof generatedPredicate !== 'function' || selection.continuation !== undefined)) {
        throw new StateError('validation', 'Generated page filters do not support cursor continuation.');
      }
      const archived = queryArchiveMode(selection.archived);
      const order = viewerPageOrder(selection.order);
      const whereBase = selection.where === undefined ? null : viewerPagePredicateTuple(selection.where);
      const search = viewerPageSearchTuple(selection.search, descriptor);
      const where: ViewerPageTuple | null = search === null ? whereBase : ['and-search', whereBase, search];
      const context = { actorUserId: call.actorUserId, teamId: call.teamId };
      const readDef = (name: ModelName): GeneratedOperationDef => {
        const def = input.registry.get(`${name}.read`);
        if (def === undefined || !isGeneratedOperationDef(def) || def.descriptor.kind !== 'read' ||
            def.descriptor.inputs.length !== 0 || !input.models?.some(candidate => candidate.name === name)) {
          throw new StateError('validation', 'Parent scope requires a checked generated model read.');
        }
        return def;
      };
      const parentPolicies = new Map<ModelName, ViewerPageParentPolicy>();
      const parent = selection.parent;
      if (parent !== undefined) {
        if (typeof parent !== 'object' || parent === null || Array.isArray(parent) ||
            typeof parent.model !== 'string' || parent.model === '' || typeof parent.id !== 'string' || parent.id === '' ||
            Object.keys(parent).length !== 2 || !Object.hasOwn(parent, 'model') || !Object.hasOwn(parent, 'id') ||
            input.containment.get(model)?.parent !== parent.model) {
          throw new StateError('validation', 'Page parent must match the checked containing model.');
        }
        let selected: ModelName | undefined = parent.model;
        while (selected !== undefined) {
          if (parentPolicies.has(selected)) throw new StateError('validation', 'Invalid cyclic page parent scope.');
          const def = readDef(selected);
          const ancestor: ModelName | undefined = input.containment.get(selected)?.parent;
          parentPolicies.set(selected, { by: def.by, ...(ancestor === undefined ? {} : { parent: ancestor }) });
          selected = ancestor;
        }
      }
      const scopeModels = new Set<ModelName>([model, ...parentPolicies.keys()]);
      if (sourceReadPolicies !== undefined) {
        let ancestor = input.containment.get(model)?.parent;
        const visited = new Set<ModelName>([model]);
        while (ancestor !== undefined) {
          if (visited.has(ancestor)) throw new StateError('validation', 'Invalid cyclic page parent scope.');
          visited.add(ancestor); scopeModels.add(ancestor);
          readDef(ancestor);
          ancestor = input.containment.get(ancestor)?.parent;
        }
      }
      const scopes: CheckedViewerPageDefinition[8] = [...scopeModels].map(name => {
        const containment = input.containment.get(name);
        const relation: ViewerPageTuple | null = containment?.parent !== undefined ? ['parent', containment.parent] :
          containment?.scope !== undefined ? ['scope', containment.scope] : null;
        const policy = input.policy.get(name);
        const installed = sourceReadPolicies?.get(name);
        const policyTuple: ViewerPageTuple | null = installed !== undefined && 'grants' in installed
          ? ['installed-source', [...installed.fields], [...installed.secretFields], installed.parent ?? null,
            installed.grants.map(grant => [...grant.fields])]
          : policy === undefined ? null : [
            [...policy.secretFields], policy.grants.map(grant => [pageByTuple(grant.by), [...grant.fields],
              grant.when === undefined ? null : viewerPagePredicateTuple(grant.when)]),
          ];
        const readBy = name === model ? call.def.by : parentPolicies.get(name)?.by ?? readDef(name).by;
        return [name, relation, pageByTuple(readBy), installed !== undefined && 'by' in installed
          ? ['installed-legacy', pageByTuple(installed.by), installed.parent ?? null, policyTuple] : policyTuple];
      });
      const definitionPrefix: CheckedViewerPageDefinitionPrefix = [
        'viewer-page/v1', [model, call.def.descriptor.name, pageByTuple(call.def.by)],
        parent === undefined ? null : [parent.model, parent.id], ['archived', archived, where],
        [...order.map(term => [term.field, term.direction] as const), ['id', 'asc']],
        selection.limit ?? VIEWER_PAGE_DEFAULT_LIMIT, VIEWER_PAGE_MAX_CANDIDATES,
        order.map(term => {
          const field = Object.hasOwn(descriptor.fields, term.field) ? descriptor.fields[term.field] : undefined;
          return [term.field, field?.valueType ?? null, field?.array?.required ?? null];
        }), scopes,
      ];
      return queryRecordsPageWithParentPolicies({
        policy: input.policy, model, modelDescriptor: descriptor, authority: 'viewer', context,
        memberships: input.memberships, store: input.store, fence: openFenceScope(call.revision, call.teamId ?? 'app'), selection,
        ...(generatedPredicate === undefined ? {} : { generatedPredicate }),
        ...(sourceReadPolicies === undefined ? {} : { sourceReadPolicies }),
      }, parentPolicies, call.def.by, async (page, childGrants, parents) => {
        const queryDefinition: CheckedViewerPageDefinition = [
          ...definitionPrefix, [true, [...childGrants], parents.map(item => [item.model, true, [...item.allowed]] as const)],
        ];
        const result: ViewerPageResult = { ...page, queryDefinition: structuredClone(queryDefinition) };
        return transform === undefined ? result : await transform(result);
      }, revalidate => { finalizePage = revalidate; });
    },
  });
  await finalizePage!();
  return admitted.result;
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
