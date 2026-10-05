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
  InvocationContext,
  ModelName,
  Receipt,
  ReceiptIdentity,
  RecordId,
  RecordVersion,
  Revision,
  StoragePort,
  StoredRow,
} from '../../../contracts/src/state.js';
import type { ClosedInputs, FieldError } from '../../../contracts/src/wire.js';
import type { GeneratedOperationDef, InterimOperationDef } from './registry.js';
import { isGeneratedOperationDef } from './registry.js';
import type { MembershipReader } from '../policy/roles.js';
import { evaluateBy } from '../policy/roles.js';
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

interface PendingRef {
  param: string;
  model: ModelName;
  id: RecordId;
  expectedVersion: RecordVersion | null;
}

/**
 * Closed-shape validation against the interim descriptor. Unknown members,
 * missing required inputs, malformed record refs, and non-canonical versions
 * aggregate into one `validation` rejection with field-level paths.
 */
function validateInputs(def: InterimOperationDef, inputs: ClosedInputs): PendingRef[] {
  const fields: FieldError[] = [];
  for (const key of Object.keys(inputs)) {
    if (!Object.hasOwn(def.inputs, key)) {
      fields.push({ path: `/${key}`, code: 'unknown_input', message: `Unknown input "${key}".` });
    }
  }
  const refs: PendingRef[] = [];
  for (const [param, paramDef] of Object.entries(def.inputs)) {
    if (!Object.hasOwn(inputs, param)) {
      if (paramDef.required) {
        fields.push({
          path: `/${param}`,
          code: 'required',
          message: `Missing required input "${param}".`,
        });
      }
      continue;
    }
    if (paramDef.type !== 'record') continue;
    const value = inputs[param] as Record<string, unknown> | null;
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
  return refs;
}

/**
 * T16a closed-shape validation against a generated descriptor. Same contract
 * as the interim validator: unknown members, missing required inputs,
 * malformed record refs, and non-canonical versions aggregate into one
 * `validation` rejection with field-level paths and the same codes. Two
 * generated-only rules: omitted ordinary-array inputs fill `[]` (T16 honors
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
        if (marker !== undefined && !marker.required) {
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
}): Promise<AdmittedCall> {
  const { def, inputs, context, store, memberships } = input;
  // DESIGN §7 step 1: read the primary revision BEFORE all other
  // state-dependent reads (receipt, membership, rows), so the commit-time
  // fence assertion covers everything admission observed.
  const revision = await store.readRevision();
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
    const allowed = await evaluateBy(def.by, { actorUserId, teamId, membership, memberships });
    if (!allowed) {
      throw new StateError('forbidden', 'This operation is not permitted for the caller.');
    }
  }

  // T16a: generated defs validate against the canonical descriptor (with
  // ordinary-array normalization); interim defs keep their exact validator.
  // The normalized copy flows to execution; the receipt hash above already
  // covered the raw supplied inputs.
  let pending: PendingRef[];
  let admittedInputs: Record<string, unknown>;
  if (isGeneratedOperationDef(def)) {
    const validated = validateGeneratedInputs(def, inputs);
    pending = validated.refs;
    admittedInputs = validated.normalized;
  } else {
    pending = validateInputs(def, inputs);
    admittedInputs = inputs;
  }

  const recordRefs: Array<PendingRef & { row: StoredRow }> = [];
  for (const ref of pending) {
    const row = await store.load(ref.model, ref.id);
    if (row === null) {
      throw new StateError('not_found', 'Record not found.');
    }
    if (ref.expectedVersion !== null && row.version !== ref.expectedVersion) {
      throw new StateError('conflict', 'Stale record version.');
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
    recordRefs.push({ ...ref, row });
  }

  return { context, def, inputs: admittedInputs, recordRefs, inputHash, revision, replay: null };
}
