/**
 * Lane 03 S3: operation admission (receipt check, authorization, shape,
 * version fencing). T16a admits generated descriptors through this same
 * canonical path — no parallel engine.
 *
 * Order is load-bearing per DESIGN §7: read the revision first, then hash
 * inputs and check the receipt before age, authorization, shape, version,
 * or business evaluation. A matching receipt replays the saved outcome
 * even though its submitted versions are now stale; a mismatched hash on
 * the same identity is a conflict.
 */

import type {
  AdmissionKind,
  CanonicalInputDef,
  CanonicalOperationKind,
  InvocationContext,
  ModelName,
  Receipt,
  ReceiptIdentity,
  RecordId,
  RecordVersion,
  Revision,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import type {
  ClosedInputs,
  ConflictCurrent,
  FieldError,
} from '@canlang/contracts';
import type { GeneratedOperationDef, InterimOperationDef } from './registry.js';
import { isGeneratedOperationDef } from './registry.js';
import type { ByPredicate, MembershipReader } from '../policy/roles.js';
import { byRequiresCallerMembership, evaluateBy } from '../policy/roles.js';
import { isSecretValue } from '../policy/grants.js';
import { assertOperationIdAge } from './context.js';
import { hashInputs } from './replay.js';
import { StateError } from '../errors.js';

/** One admitted mutation call with its loaded record rows and fence. */
export interface AdmittedCall {
  context: InvocationContext;
  def: InterimOperationDef | GeneratedOperationDef;
  inputs: Record<string, unknown>;
  recordRefs: ReadonlyArray<{
    param: string;
    model: ModelName;
    id: RecordId;
    expectedVersion: RecordVersion | null;
    row: StoredRow;
  }>;
  inputHash: string;
  revision: Revision;
  replay: Receipt | null;
  /**
   * T32b checkpoint enrollment: the owner checkpoint this call's
   * state-dependent reads enrolled in (membership, record refs, parent
   * linkage). Optional so older constructed calls keep compiling; the
   * fenced commit re-asserts `revision` unconditionally and runs
   * `revalidateCommitForFence` when a checkpoint is present.
   */
  checkpoint?: FenceCheckpoint;
}

/** Derive the receipt identity for a context (single home for the mapping). */
export function receiptIdentityFor(context: InvocationContext): ReceiptIdentity {
  return {
    app: context.app,
    owner: context.team?.teamId ?? 'app',
    principal: context.actor?.userId ?? context.trustedSource ?? 'public',
    operation: context.operation,
    operationId: context.operationId,
  };
}

/**
 * Canonical decimal integer string >= 1: no sign, no decimals, no leading
 * zeros, at most 15 digits (well under 2^53, so `Number()` cannot lose
 * precision or reach Infinity).
 */
const CANONICAL_VERSION_RE = /^[1-9][0-9]{0,14}$/;

export interface PendingRef {
  param: string;
  model: ModelName;
  id: RecordId;
  expectedVersion: RecordVersion | null;
}

/**
 * B2 (Q3): serverOnly field names per model, threaded from the
 * table/descriptor holder (the seam builds it from the loaded models) so
 * admission-denial currents exclude server-resolved fields. Keyed by
 * model name; a model with no serverOnly fields carries an EMPTY set
 * (values flow). A MISSING map — or a model missing from it — reads as
 * unknown exclusions: currents carry metadata only (`values: {}`),
 * fail closed. Never inferred, never guessed.
 */
export type ConflictServerOnly = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * T17a: the interim input descriptor translated 1:1 onto a synthetic
 * generated def so interim calls validate through the canonical generated
 * validator below. Record inputs map to same-named ref inputs (model,
 * versioned, and required carried verbatim, descriptor-input order following
 * the interim def's entry order); scalar inputs map to presence-only scalar
 * inputs (the canonical validator treats every non-ref kind uniformly, so
 * the `string` spelling is arbitrary); the interim kinds map to their
 * canonical twins. The synthetic def carries NO input array markers:
 * hand-built interim defs hold none, so no omission-fill and no array-shape
 * check can fire — exactly the retired interim validator's behavior.
 */
function toSyntheticGeneratedDef(def: InterimOperationDef): GeneratedOperationDef {
  const kind: CanonicalOperationKind =
    def.kind === 'crud.create'
      ? 'create'
      : def.kind === 'crud.update'
        ? 'update'
        : def.kind === 'crud.delete'
          ? 'delete'
          : def.kind;
  const inputs: CanonicalInputDef[] = Object.entries(def.inputs).map(([name, param]) =>
    param.type === 'record'
      ? {
          name,
          kind: 'ref',
          model: param.model,
          versioned: param.versioned,
          required: param.required,
        }
      : { name, kind: 'string', required: param.required },
  );
  return {
    generated: true,
    name: def.name,
    kind,
    descriptor: { name: def.name, kind, inputs },
    by: def.by,
    inputArrays: {},
  };
}

/**
 * Closed-shape validation against an interim descriptor. T17a RETIRED the
 * interim validation body: interim defs translate onto a synthetic
 * generated def and run through the canonical generated validator, so
 * there is exactly one closed-shape implementation. Same codes, paths,
 * messages, and field order as the removed body (equivalence pinned by the
 * T17a retirement tests; the interim suites exercise every path). Only the
 * pending refs are returned — interim execution keeps the caller's inputs
 * object (see `validateCallInputs`).
 */
function validateInputs(def: InterimOperationDef, inputs: ClosedInputs): PendingRef[] {
  return validateGeneratedInputs(toSyntheticGeneratedDef(def), inputs).refs;
}

/**
 * T16a closed-shape validation against a generated descriptor. Same contract
 * as the interim validator: unknown members, missing required inputs,
 * malformed record refs, and non-canonical versions aggregate into one
 * `validation` rejection with field-level paths and the same codes. Two
 * generated-only rules: omitted nonnullable ordinary-array inputs without defaults fill `[]`
 * outside updates (T16 honors
 * the T15a input array marker; required-array omission on creates is
 * enforced by the model table in the pipeline), and present non-null values
 * for array-marked inputs must be arrays. Scalar values are presence-only
 * (no enum-membership or scalar-bound checks — parity with interim; L2/T18
 * own value semantics), and operation-input defaults are NOT filled here:
 * creates fill model-level defaults in the pipeline, and scenario defaults
 * stay with the emitted `default(c)` callable (T18 execution).
 *
 * Returns the pending record refs plus the normalized inputs (a copy of the
 * caller's object with ordinary-array fills applied). The receipt input hash
 * is computed from the RAW inputs before this runs (frozen order), so fills
 * — deterministic from the descriptor — never perturb replay identity.
 */
function validateGeneratedInputs(
  def: GeneratedOperationDef,
  inputs: ClosedInputs,
): { refs: PendingRef[]; normalized: Record<string, unknown> } {
  const expected = new Map(def.descriptor.inputs.map((input) => [input.name, input]));
  const fields: FieldError[] = [];
  for (const key of Object.keys(inputs)) {
    if (!expected.has(key)) {
      fields.push({ path: `/${key}`, code: 'unknown_input', message: `Unknown input "${key}".` });
    }
  }
  const normalized: Record<string, unknown> = { ...inputs };
  const refs: PendingRef[] = [];
  for (const paramDef of def.descriptor.inputs) {
    const param = paramDef.name;
    if (!Object.hasOwn(inputs, param)) {
      if (paramDef.required) {
        fields.push({
          path: `/${param}`,
          code: 'required',
          message: `Missing required input "${param}".`,
        });
      } else {
        const marker = def.inputArrays[param];
        if (marker !== undefined && !marker.required && def.descriptor.kind !== 'update' &&
            paramDef.default === undefined &&
            !(paramDef.kind !== 'ref' && paramDef.kind !== 'delivery' &&
              Object.hasOwn(paramDef, 'valueType') && paramDef.valueType?.endsWith('?'))) {
          normalized[param] = [];
        }
      }
      continue;
    }
    if (paramDef.kind !== 'ref') {
      const marker = def.inputArrays[param];
      const value = inputs[param];
      if (marker !== undefined && value !== null && !Array.isArray(value)) {
        fields.push({
          path: `/${param}`,
          code: 'invalid_array',
          message: `Input "${param}" must be an array.`,
        });
      }
      continue;
    }
    const value = inputs[param] as Record<string, unknown> | null;
    if (value === null && def.inputNullableRefs !== undefined &&
      Object.hasOwn(def.inputNullableRefs, param) && def.inputNullableRefs[param] === true &&
      !Object.hasOwn(def.inputArrays, param)) {
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      fields.push({
        path: `/${param}`,
        code: 'invalid_ref',
        message: `Input "${param}" must be a record reference with an id.`,
      });
      continue;
    }
    const id = value['id'];
    if (typeof id !== 'string' || id === '') {
      fields.push({
        path: `/${param}`,
        code: 'invalid_ref',
        message: `Input "${param}" must be a record reference with an id.`,
      });
      continue;
    }
    const hasVersion = Object.hasOwn(value, 'version');
    if (paramDef.versioned && !hasVersion) {
      fields.push({
        path: `/${param}`,
        code: 'version_required',
        message: `Input "${param}" requires an expected version.`,
      });
      continue;
    }
    let expectedVersion: RecordVersion | null = null;
    if (hasVersion) {
      const version = value['version'];
      if (typeof version !== 'string' || !CANONICAL_VERSION_RE.test(version)) {
        fields.push({
          path: `/${param}`,
          code: 'invalid_version',
          message: `Input "${param}" carries a malformed record version.`,
        });
        continue;
      }
      expectedVersion = Number(version) as RecordVersion;
    }
    refs.push({ param, model: paramDef.model, id: id as RecordId, expectedVersion });
  }
  if (fields.length > 0) {
    throw new StateError('validation', 'Invalid operation inputs.', null, { fields });
  }
  return { refs, normalized };
}

/** Validated call inputs: pending record refs plus the execution inputs. */
export interface ValidatedCallInputs {
  readonly refs: ReadonlyArray<PendingRef>;
  readonly normalized: Record<string, unknown>;
}

/**
 * T17a: one closed-shape validation entry for both def families. Generated
 * defs validate against the canonical descriptor (the normalized copy, with
 * ordinary-array fills, flows to execution); interim defs validate through
 * the same canonical validator via a synthetic def and keep the caller's
 * inputs object (no copy — exactly the pre-T17a interim contract). Used by
 * `admit` for mutations and by `invokeRead` for generated reads, so reads
 * and writes share one closed-shape implementation.
 */
export function validateCallInputs(
  def: InterimOperationDef | GeneratedOperationDef,
  inputs: ClosedInputs,
): ValidatedCallInputs {
  if (isGeneratedOperationDef(def)) {
    return validateGeneratedInputs(def, inputs);
  }
  return { refs: validateInputs(def, inputs), normalized: inputs };
}

/**
 * Admit one invocation. Trusted calls skip the `by` check on their verified
 * source authority; every other kind runs it. System/test kinds admit
 * uniformly through this same path. Generated defs run the identical
 * revision/hash/receipt/age/by/load order with canonical closed-shape
 * validation; interim defs keep their exact prior behavior.
 */
export async function admit(input: {
  def: InterimOperationDef | GeneratedOperationDef;
  inputs: ClosedInputs;
  context: InvocationContext;
  store: StoragePort;
  memberships: MembershipReader;
  /**
   * B2 (Q3): serverOnly exclusions for denial currents (see
   * `ConflictServerOnly`). Absent reads as unknown: stale-ref denials
   * still carry row metadata, but `values` stays `{}`.
   */
  conflictServerOnly?: ConflictServerOnly;
}): Promise<AdmittedCall> {
  const { def, inputs, context, store, memberships } = input;
  // DESIGN §7 step 1: read the primary revision BEFORE all other
  // state-dependent reads (receipt, membership, rows), so the commit-time
  // fence assertion covers everything admission observed.
  const revision = await store.readRevision();
  // T32b: the owner checkpoint every state-dependent read of this
  // operation enrolls in (the settled revision fence, not a second
  // fence). Owner is the team when scoped, else the deployment app.
  const scope = openFenceScope(revision, context.team?.teamId ?? context.app);
  const inputHash = await hashInputs(inputs);

  const existing = await store.readReceipt(receiptIdentityFor(context));
  if (existing !== null) {
    if (existing.inputHash !== inputHash) {
      throw new StateError('conflict', 'Conflicting reuse of this operation identity.');
    }
    return {
      context,
      def,
      inputs,
      recordRefs: [],
      inputHash,
      revision: existing.committedRevision,
      replay: existing,
      checkpoint: scope.snapshot(),
    };
  }

  // DESIGN §7: age applies to UNSEEN identities only — a live receipt
  // above already replayed regardless of identity age.
  assertOperationIdAge(context.operationId, context.now);

  if (context.kind !== 'trusted') {
    const actorUserId = context.actor?.userId ?? null;
    const teamId = context.team?.teamId ?? null;
    const membership =
      actorUserId !== null && teamId !== null
        ? await memberships.findMembership(teamId, actorUserId)
        : null;
    if (actorUserId !== null && teamId !== null) {
      scope.enroll({ kind: 'membership', teamId, userId: actorUserId });
    }
    const allowed = await evaluateBy(def.by, { actorUserId, teamId, membership, memberships });
    if (!allowed) {
      throw new StateError('forbidden', 'This operation is not permitted for the caller.');
    }
  }

  // T17a: one validation entry — generated defs validate against the
  // canonical descriptor (the normalized copy, with ordinary-array fills,
  // flows to execution); interim defs run through the same canonical
  // validator via a synthetic def and keep the caller's inputs object.
  // Either way the receipt hash above already covered the raw supplied
  // inputs. Interim behavior is unchanged (same codes/paths/messages).
  const validated = validateCallInputs(def, inputs);
  const pending = validated.refs;
  const admittedInputs = validated.normalized;

  const recordRefs: Array<PendingRef & { row: StoredRow }> = [];
  for (const ref of pending) {
    const row = await store.load(ref.model, ref.id);
    if (row === null) {
      throw new StateError('not_found', 'Record not found.');
    }
    if (ref.expectedVersion !== null && row.version !== ref.expectedVersion) {
      // B2 (Q3): the row is in hand — carry full per-binding currents
      // (zero extra reads). `values` = submitted-input names intersect
      // row data, MINUS serverOnly fields (holder-threaded exclusions)
      // MINUS secret-kind values by shape (defense in depth). Unknown
      // exclusions (no map, or no entry for this model) carry metadata
      // only — fail closed, never guessed.
      const excluded = input.conflictServerOnly?.get(ref.model as string);
      const values: Record<string, unknown> = {};
      if (excluded !== undefined) {
        for (const name of Object.keys(admittedInputs)) {
          if (!Object.hasOwn(row.data, name) || excluded.has(name)) {
            continue;
          }
          const current = row.data[name];
          if (isSecretValue(current)) {
            continue;
          }
          values[name] = structuredClone(current);
        }
      }
      const conflict: ConflictCurrent = {
        message:
          `Input ${JSON.stringify(`/${ref.param}`)} is stale (expected version ` +
          `${ref.expectedVersion as number}, current ${row.version as number}).`,
        current: {
          model: ref.model as string,
          id: ref.id as string,
          version: row.version as number,
          updated: new Date(row.updated).toISOString(),
          updatedBy: row.updatedBy,
          values,
        },
      };
      throw new StateError('conflict', 'Stale record version.', null, { conflict });
    }
    // L3-authored mapping (coordinator-confirmed): archived targets exist
    // but are ineligible for new references, which is a
    // well-formed-request/business-eligibility failure rather than a missing
    // row, so it maps to `validation`, not `not_found`. The caller holds a
    // versioned reference proving prior knowledge, so hiding adds nothing;
    // viewer read paths hide archived rows independently. Note the check
    // order: a stale version on an archived row reports `conflict` first.
    if (row.archivedAt !== null) {
      throw new StateError('validation', 'Archived records cannot be used here.');
    }
    scope.enroll({ kind: 'record', model: ref.model, id: ref.id, version: row.version });
    if (row.parent !== undefined && row.parent !== null) {
      enrollImportedParentRead(scope, { model: row.parent.model, id: row.parent.id });
    }
    recordRefs.push({ ...ref, row });
  }

  return {
    context,
    def,
    inputs: admittedInputs,
    recordRefs,
    inputHash,
    revision,
    replay: null,
    checkpoint: scope.snapshot(),
  };
}

/* -- T32b checkpoint fence (adopted Alternative A). -- */

/**
 * One state-dependent read enrolled in an operation's owner checkpoint.
 * The database-wide revision assertion is the security property (any
 * intervening write moves the revision and voids the commit); the enrolled
 * dependency list exists for invalidating-read attribution and for the
 * still-open narrower-fence question (see the T32b report).
 */
export type CheckpointDependency =
  /** Live membership/role read backing a `by` or policy predicate. */
  | { readonly kind: 'membership'; readonly teamId: string; readonly userId: string }
  /** Record row observed at a version (admission ref loads). */
  | {
      readonly kind: 'record';
      readonly model: ModelName;
      readonly id: RecordId;
      readonly version: RecordVersion;
    }
  /** Authorized query served at the checkpoint (engine enrollment). */
  | { readonly kind: 'query'; readonly model: ModelName; readonly authority: 'viewer' | 'owner' }
  /**
   * Imported-parent linkage observed at the checkpoint. Per adopted T28-A,
   * plain-import parents share the caller's owner, store, and atomic
   * commit, so the read enrolls in the SAME owner checkpoint — never a
   * cross-owner fence. (Bound `from=` parents stay rejected and have no
   * enrollment; a future bound read is a cross-owner reference read, not
   * a same-fence containment read.)
   */
  | { readonly kind: 'imported-parent'; readonly model: ModelName; readonly id: RecordId };

/** Frozen owner checkpoint: one revision plus its enrolled read dependencies. */
export interface FenceCheckpoint {
  readonly revision: Revision;
  readonly owner: string;
  readonly dependencies: ReadonlyArray<CheckpointDependency>;
}

/**
 * Mutable single-operation enrollment scope over one owner checkpoint.
 * Guards, `when=`, derives, policy predicates, membership checks, and
 * record loads enroll here; `snapshot()` freezes the checkpoint the
 * fenced commit re-asserts. One scope per operation; transitive effects
 * open their own via `openTransitiveScope`, never by inheriting this one.
 */
export interface FenceScope {
  readonly revision: Revision;
  readonly owner: string;
  readonly dependencies: ReadonlyArray<CheckpointDependency>;
  enroll(dependency: CheckpointDependency): void;
  snapshot(): FenceCheckpoint;
}

function dependencyKey(dependency: CheckpointDependency): string {
  switch (dependency.kind) {
    case 'membership':
      return `membership\0${dependency.teamId}\0${dependency.userId}`;
    case 'record':
      return `record\0${dependency.model}\0${dependency.id}\0${dependency.version}`;
    case 'query':
      return `query\0${dependency.model}\0${dependency.authority}`;
    case 'imported-parent':
      return `imported-parent\0${dependency.model}\0${dependency.id}`;
  }
}

/** Open one operation's enrollment scope at an already-read owner checkpoint. */
export function openFenceScope(revision: Revision, owner: string): FenceScope {
  const seen = new Set<string>();
  const enrolled: CheckpointDependency[] = [];
  return {
    revision,
    owner,
    get dependencies(): ReadonlyArray<CheckpointDependency> {
      return enrolled;
    },
    enroll(dependency: CheckpointDependency): void {
      const key = dependencyKey(dependency);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      enrolled.push(dependency);
    },
    snapshot(): FenceCheckpoint {
      return { revision, owner, dependencies: [...enrolled] };
    },
  };
}

/**
 * Enroll an imported-parent read in the CALLER's scope (adopted T28-A:
 * same owner, same checkpoint, same revision fence). The read takes no
 * new scope and no cross-owner boundary.
 */
export function enrollImportedParentRead(
  scope: FenceScope,
  parent: { readonly model: ModelName; readonly id: RecordId },
): void {
  scope.enroll({ kind: 'imported-parent', model: parent.model, id: parent.id });
}

/**
 * Open a transitive effect's fence scope: hook bodies and committed
 * handlers re-read CURRENT authority state at their own checkpoint rather
 * than inheriting the triggering read's snapshot. The scope starts with
 * zero enrolled dependencies by construction — inheritance is
 * unrepresentable. The caller owns the trigger revision for diagnostics;
 * it is never consulted here.
 */
export async function openTransitiveScope(
  store: Pick<StoragePort, 'readRevision'>,
  owner: string,
): Promise<FenceScope> {
  return openFenceScope(await store.readRevision(), owner);
}

/**
 * Structural eventual-read marker test. Eventual (display-only,
 * stale-tolerant) reads enroll nothing and carry `eventual: true` on
 * their result wrapper (see `query/engine.ts`); they can NEVER feed an
 * authorization decision or a spend. Structural (not nominal) so the
 * marker survives the engine/admission boundary without an import cycle.
 */
export function isEventualRead(reading: unknown): boolean {
  return (
    typeof reading === 'object' &&
    reading !== null &&
    (reading as { readonly eventual?: unknown }).eventual === true
  );
}

/**
 * Refuse an eventual read at an authorization boundary. The fenced commit
 * runs this over every reading the operation offers as authorization
 * evidence; display-only eventual reads keep their reread/stale-marking
 * contract and are statically shaped apart (the `EventualRecordsResult`
 * wrapper), with this runtime bar where shapes meet.
 */
export function requireAuthorizingRead(reading: unknown, what: string): void {
  if (isEventualRead(reading)) {
    throw new StateError(
      'validation',
      `${what} cannot authorize from a display-only eventual read; re-read at the fence.`,
    );
  }
}

/** One guard/`when=` predicate the fenced commit re-evaluates live. */
export interface GuardRevalidation {
  /** Stable predicate name for invalidating-read attribution. */
  readonly name: string;
  /** Re-run against CURRENT state; false voids the commit. */
  readonly evaluate: () => boolean | Promise<boolean>;
}

/** Commit-time revalidation input: checkpoint plus live authority readers. */
export interface CommitRevalidationInput {
  readonly checkpoint: FenceCheckpoint;
  /** The operation's `by`, re-evaluated against live membership state. */
  readonly by: ByPredicate;
  /** Guard/`when=` predicates, re-evaluated live (attribution by name). */
  readonly guards: ReadonlyArray<GuardRevalidation>;
  readonly actorUserId: string | null;
  readonly teamId: string | null;
  readonly kind: AdmissionKind;
  readonly store: Pick<StoragePort, 'readRevision'>;
  readonly memberships: MembershipReader;
  /**
   * Readings offered as authorization evidence; any eventual-marked
   * reading voids the commit (eventual reads never authorize).
   */
  readonly readings?: ReadonlyArray<unknown>;
}

/**
 * T32b commit-time revalidation (adopted Alternative A): the fenced commit
 * re-asserts the checkpoint revision AND re-evaluates permission +
 * revocation against CURRENT authority state.
 *
 * Order: (1) eventual bar over offered readings; (2) revision assertion —
 * any intervening change to a read dependency fails with `conflict`
 * (stale revision); (3) live authority revalidation — a revoked
 * permission fails with `forbidden`, never a silent commit. Trusted-kind
 * calls skip step 3 exactly like admission (verified source authority),
 * but the revision assertion still applies unconditionally.
 *
 * Revocation scope (L291 NARROWER reading): authority revoked between
 * admission and commit VOIDS the in-flight commit — the already-admitted
 * operation does NOT finish when its authority is gone (matches the
 * proven Grant deactivate-then-deny immediacy). Still open: revocation
 * racing an already-fenced commit batch (storage-atomicity question for
 * the durable fence proof, not decided here).
 *
 * Membership/role facts always come from the live reader, never from
 * trusted claims or checkpoint snapshots: the checkpoint names WHICH
 * memberships were read, and step 3 re-reads them.
 */
export async function revalidateCommitForFence(input: CommitRevalidationInput): Promise<void> {
  for (const reading of input.readings ?? []) {
    requireAuthorizingRead(reading, 'The fenced commit');
  }
  const current = await input.store.readRevision();
  if (current !== input.checkpoint.revision) {
    throw new StateError(
      'conflict',
      `Checkpoint moved during the operation (enrolled at revision ${input.checkpoint.revision}, ` +
        `now at ${current}); ${input.checkpoint.dependencies.length} enrolled read(s) must re-fence.`,
    );
  }
  if (input.kind === 'trusted') {
    return;
  }
  const live =
    input.actorUserId !== null && input.teamId !== null
      ? await input.memberships.findMembership(input.teamId, input.actorUserId)
      : null;
  // B4-authority: the explicit revocation void is by-aware — it fires only
  // for gates whose authority flows from the caller's own membership row.
  // Gates that can authorize without caller membership skip it (a missing
  // caller row was never their authority); the live `evaluateBy` below
  // still voids genuinely lost permission for every gate.
  if (
    byRequiresCallerMembership(input.by) &&
    input.actorUserId !== null &&
    input.teamId !== null &&
    (live === null || live.status !== 'active')
  ) {
    throw new StateError(
      'forbidden',
      'Authority revoked during the operation; the commit is void.',
    );
  }
  const allowed = await evaluateBy(input.by, {
    actorUserId: input.actorUserId,
    teamId: input.teamId,
    membership: live,
    memberships: input.memberships,
  });
  if (!allowed) {
    throw new StateError(
      'forbidden',
      'Permission no longer holds at commit; the commit is void.',
    );
  }
  for (const guard of input.guards) {
    if ((await guard.evaluate()) !== true) {
      throw new StateError(
        'forbidden',
        `Guard ${JSON.stringify(guard.name)} no longer holds at commit; the commit is void.`,
      );
    }
  }
}

/* -- T34-F5 fanout child fence scope (ADDITIVE; existing fence untouched). -- */

/**
 * Open one fanout child's fence scope: a FRESH transitive scope at the
 * child's own checkpoint, never inheriting the source occurrence's or a
 * sibling's checkpoint. Fanout children are transitive effects — each
 * re-reads CURRENT authority state (membership, record refs, parent
 * linkage) at its own checkpoint, so revocation between siblings voids
 * only the revoked child. Drivers that stage pre-checks outside
 * `invoke` (claim guards, lifecycle reads) enroll them here; children
 * admitted through `invokeFanoutChild` get an equivalent fresh scope
 * from `admit` itself.
 */
export async function openFanoutChildScope(
  store: Pick<StoragePort, 'readRevision'>,
  owner: string,
): Promise<FenceScope> {
  if (typeof owner !== 'string' || owner === '') {
    throw new StateError('validation', 'Fanout child scope needs a non-empty owner.');
  }
  return openTransitiveScope(store, owner);
}
