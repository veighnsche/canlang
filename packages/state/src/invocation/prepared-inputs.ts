/**
 * V02.4 state prepared-inputs leaf (input-validation profile
 * `state-generated/v1`).
 *
 * A prepared plan freezes, for one loader-produced generated operation,
 * the exact closed-shape evaluation `admit`/`invokeRead` perform at the
 * post-replay/age/auth validation point (`validateCallInputs`,
 * `admission.ts`): unknown members, missing required inputs, array
 * shape, malformed record refs, and non-canonical versions aggregate
 * into one `validation` rejection with field-level paths and the same
 * codes — and the runner below reorders nothing, re-derives nothing,
 * and invents no parallel rule. The current-TS validator is the oracle:
 * prepared runs must agree with it exactly (pinned differentially by
 * `test/invocation/owned-admission.test.ts`).
 *
 * Owned semantics (V01.1 `state-generated/v1`): generated scalars are
 * presence-only (no enum-membership or scalar-bound checks); versions
 * are positive integers of at most 15 digits (`/^[1-9][0-9]{0,14}$/`,
 * safe-number conversion); record refs tolerate extra members;
 * operation defaults are NEVER filled (defaults stay host-owned);
 * omitted optional ordinary-array inputs fill a FRESH `[]` per call;
 * the normalized output is a fresh unfrozen shallow copy.
 *
 * Provenance: plans build ONLY from loader-produced generated defs
 * (or a validated descriptor plus its engine-local array markers).
 * Interim defs are hand-built and carry no proven provenance, so
 * `prepareOperationInputs` refuses them outright — interim calls keep
 * their exact legacy identity (the caller's inputs object, no copy).
 * Every plan field is a copied primitive: post-registration mutation
 * of the source descriptor cannot alter the plan, and the loader
 * builds a fresh plan per def per load — permissive unknown-loader
 * results are never cached by operation name or caller type.
 */

import type {
  CanonicalOperationDescriptor,
  ModelName,
  RecordId,
  RecordVersion,
} from '@canlang/contracts';
import type { ClosedInputs, FieldError } from '@canlang/contracts';
import type {
  GeneratedOperationDef,
  InterimOperationDef,
} from './registry.js';
import type { PendingRef, ValidatedCallInputs } from './admission.js';
import { StateError } from '../errors.js';

/** Input-validation profile this leaf implements (V01.1 `state-generated/v1`). */
export const PREPARED_INPUTS_PROFILE = 'state-generated/v1' as const;

/**
 * Canonical decimal integer string >= 1: no sign, no decimals, no leading
 * zeros, at most 15 digits (well under 2^53, so `Number()` cannot lose
 * precision or reach Infinity). Same domain as admission's version check.
 */
const CANONICAL_VERSION_RE = /^[1-9][0-9]{0,14}$/;

/**
 * One prepared input rule: copied data-only metadata for a single
 * descriptor input in descriptor order. Scalars collapse to
 * `ref: null` (presence-only — the canonical validator treats every
 * non-ref kind uniformly, so no scalar kind is retained).
 */
export interface PreparedInputRule {
  readonly name: string;
  readonly ref: { readonly model: ModelName; readonly versioned: boolean } | null;
  readonly required: boolean;
  /** Fill `[]` when an optional input is omitted (non-required marker). */
  readonly arrayFill: boolean;
  /** Present non-null values must be arrays (any marker). */
  readonly arrayCheck: boolean;
}

/**
 * Frozen prepared plan for one operation's generated inputs: rules in
 * descriptor order plus the profile tag. Plain JSON-safe data — no
 * maps, no handles, no loader references.
 */
export interface PreparedOperationPlan {
  readonly profile: typeof PREPARED_INPUTS_PROFILE;
  readonly operation: string;
  readonly rules: ReadonlyArray<PreparedInputRule>;
}

/** Engine-local input array markers, keyed by input name. */
export type PreparedInputArrays = Readonly<
  Record<string, { readonly required: boolean }>
>;

/**
 * Prepare a validated descriptor plus its engine-local array markers.
 * Copies every rule field (primitives only) so later mutation of the
 * source descriptor or markers cannot alter the plan.
 */
export function prepareDescriptorInputs(
  descriptor: CanonicalOperationDescriptor,
  inputArrays: PreparedInputArrays,
): PreparedOperationPlan {
  const rules: PreparedInputRule[] = descriptor.inputs.map((input) => {
    const marker = inputArrays[input.name];
    return {
      name: input.name,
      ref:
        input.kind === 'ref'
          ? { model: input.model, versioned: input.versioned }
          : null,
      required: input.required,
      arrayFill: marker !== undefined && !marker.required,
      arrayCheck: marker !== undefined,
    };
  });
  return {
    profile: PREPARED_INPUTS_PROFILE,
    operation: descriptor.name as string,
    rules,
  };
}

/**
 * Prepare a generated operation def. Interim defs are hand-built and
 * carry no proven producer provenance, so they are refused outright
 * (plain caller error — never an admission rejection, since the def
 * never reaches admission through this path).
 */
export function prepareOperationInputs(
  def: InterimOperationDef | GeneratedOperationDef,
): PreparedOperationPlan {
  if (
    typeof def !== 'object' ||
    def === null ||
    (def as { generated?: unknown }).generated !== true
  ) {
    throw new Error(
      'Cannot prepare inputs for an interim operation descriptor: ' +
        'hand-built descriptors carry no proven provenance.',
    );
  }
  const generated = def as GeneratedOperationDef;
  return prepareDescriptorInputs(generated.descriptor, generated.inputArrays);
}

/**
 * Validate closed inputs against a prepared plan. Same contract as the
 * canonical generated validator: unknown members (JS enumeration
 * order), missing required inputs, malformed record refs, and
 * non-canonical versions aggregate into one `validation` rejection in
 * current order; omitted optional ordinary arrays fill a fresh `[]`;
 * the returned `normalized` object is a fresh unfrozen shallow copy.
 * Operation defaults are ignored (host-owned, never filled here).
 */
export function validatePreparedInputs(
  plan: PreparedOperationPlan,
  inputs: ClosedInputs,
): ValidatedCallInputs {
  const expected = new Map(plan.rules.map((rule) => [rule.name, rule]));
  const fields: FieldError[] = [];
  for (const key of Object.keys(inputs)) {
    if (!expected.has(key)) {
      fields.push({ path: `/${key}`, code: 'unknown_input', message: `Unknown input "${key}".` });
    }
  }
  const normalized: Record<string, unknown> = { ...inputs };
  const refs: PendingRef[] = [];
  for (const rule of plan.rules) {
    const param = rule.name;
    if (!Object.hasOwn(inputs, param)) {
      if (rule.required) {
        fields.push({
          path: `/${param}`,
          code: 'required',
          message: `Missing required input "${param}".`,
        });
      } else if (rule.arrayFill) {
        normalized[param] = [];
      }
      continue;
    }
    if (rule.ref === null) {
      const value = inputs[param];
      if (rule.arrayCheck && value !== null && !Array.isArray(value)) {
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
    if (rule.ref.versioned && !hasVersion) {
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
    refs.push({ param, model: rule.ref.model, id: id as RecordId, expectedVersion });
  }
  if (fields.length > 0) {
    throw new StateError('validation', 'Invalid operation inputs.', null, { fields });
  }
  return { refs, normalized };
}
