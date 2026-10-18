/**
 * V02.4 state prepared-inputs leaf (input-validation profile
 * `state-generated/v1`).
 *
 * A prepared plan freezes, for one loader-produced generated operation,
 * the exact closed-shape evaluation `admit`/`invokeRead` perform at the
 * post-replay/age/auth validation point (`validateCallInputs`,
 * `admission.ts`): unknown members, missing required inputs, array
 * shape/length, malformed singular or array-element refs, and non-canonical versions aggregate
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
 * omitted optional nonnullable ordinary-array inputs without defaults fill a FRESH `[]`
 * outside updates;
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
import { OwnedJsonToken, readOwnedJson } from '@canlang/values/bindings/owned-input';

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
  readonly ref: { readonly model: ModelName; readonly versioned: boolean; readonly nullable?: true } | null;
  readonly required: boolean;
  /** Fill eligible ordinary-array omissions; defaults, nullable inputs, and update omissions stay host-owned. */
  readonly arrayFill: boolean;
  /** Present non-null values must be arrays (any marker). */
  readonly arrayCheck: boolean;
  readonly min?: number;
  readonly max?: number;
}

/** Shared outer-length errors, appended in descriptor order by both validators. */
export function appendInputArrayLengthErrors(fields: FieldError[], param: string, length: number, min?: number, max?: number): boolean {
  if (min !== undefined && length < min) {
    fields.push({ path: `/${param}`, code: 'min_length', message: `Input "${param}" must contain at least ${min} items.` });
    return true;
  }
  if (max !== undefined && length > max) {
    fields.push({ path: `/${param}`, code: 'max_length', message: `Input "${param}" must contain at most ${max} items.` });
    return true;
  }
  return false;
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
/** Ordinary-array omission-fill eligibility for one prepared rule. */
function preparedArrayFill(
  input: CanonicalOperationDescriptor['inputs'][number],
  marker: { readonly required: boolean } | undefined,
  descriptor: CanonicalOperationDescriptor,
): boolean {
  return marker !== undefined && !marker.required && descriptor.kind !== 'update' &&
    input.default === undefined && !(input.kind === 'ref' && input.nullable === true) &&
    !(input.kind !== 'ref' && input.kind !== 'delivery' &&
      Object.hasOwn(input, 'computedDefault') && input.computedDefault === true) &&
    !(input.kind !== 'ref' && input.kind !== 'delivery' &&
      Object.hasOwn(input, 'valueType') && input.valueType?.endsWith('?'));
}

/** One prepared input rule: copied data-only metadata in descriptor order. */
function buildPreparedInputRule(
  input: CanonicalOperationDescriptor['inputs'][number],
  marker: { readonly required: boolean } | undefined,
  descriptor: CanonicalOperationDescriptor,
  inputNullableRefs: Readonly<Record<string, true>>,
): PreparedInputRule {
  return {
    name: input.name,
    ref:
      input.kind === 'ref'
        ? { model: input.model, versioned: input.versioned,
            ...((input.nullable === true || Object.hasOwn(inputNullableRefs, input.name) && inputNullableRefs[input.name] === true) ? { nullable: true as const } : {}) }
        : null,
    required: input.required,
    arrayFill: preparedArrayFill(input, marker, descriptor),
    arrayCheck: marker !== undefined,
    ...(input.min !== undefined ? { min: input.min } : {}),
    ...(input.max !== undefined ? { max: input.max } : {}),
  };
}

export function prepareDescriptorInputs(
  descriptor: CanonicalOperationDescriptor,
  inputArrays: PreparedInputArrays,
  inputNullableRefs: Readonly<Record<string, true>> = {},
): PreparedOperationPlan {
  const rules: PreparedInputRule[] = descriptor.inputs.map((input) =>
    buildPreparedInputRule(input, inputArrays[input.name], descriptor, inputNullableRefs));
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
  return prepareDescriptorInputs(generated.descriptor, generated.inputArrays, generated.inputNullableRefs);
}

/**
 * Validate closed inputs against a prepared plan. Same contract as the
 * canonical generated validator: unknown members (JS enumeration
 * order), missing required inputs, malformed record refs, and
 * non-canonical versions aggregate into one `validation` rejection in
 * current order; eligible ordinary-array omissions fill a fresh `[]`;
 * the returned `normalized` object is a fresh unfrozen shallow copy.
 * Operation defaults remain absent for host evaluation; update omissions remain absent.
 *
 * Owned admission: `inputs` may be a genuine parser-owned token, in
 * which case the lineage-checked value is validated without mutation
 * (frozen parser output is only read and shallow-copied). Forged
 * tokens refuse at lineage resolution; tokens resolving to
 * non-objects are caller misuse and throw.
 */
/** One ref slot (or each array element) against its rule, in slot order. */
function validatePreparedRefSlots(
  rule: PreparedInputRule,
  param: string,
  supplied: unknown,
  refs: PendingRef[],
  fields: FieldError[],
): void {
  const array = rule.arrayCheck && Array.isArray(supplied) ? supplied : undefined;
  for (let index = 0; index < (array === undefined ? 1 : array.length); index += 1) {
    const slot = array === undefined ? param : `${param}/${index}`;
    const value = (array === undefined ? supplied : array[index]) as Record<string, unknown> | null;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      fields.push({
        path: `/${slot}`,
        code: 'invalid_ref',
        message: `Input "${slot}" must be a record reference with an id.`,
      });
      continue;
    }
    const id = value['id'];
    if (typeof id !== 'string' || id === '') {
      fields.push({
        path: `/${slot}`,
        code: 'invalid_ref',
        message: `Input "${slot}" must be a record reference with an id.`,
      });
      continue;
    }
    const hasVersion = Object.hasOwn(value, 'version');
    if (rule.ref !== null && rule.ref.versioned && !hasVersion) {
      fields.push({
        path: `/${slot}`,
        code: 'version_required',
        message: `Input "${slot}" requires an expected version.`,
      });
      continue;
    }
    let expectedVersion: RecordVersion | null = null;
    if (hasVersion) {
      const version = value['version'];
      if (typeof version !== 'string' || !CANONICAL_VERSION_RE.test(version)) {
        fields.push({
          path: `/${slot}`,
          code: 'invalid_version',
          message: `Input "${slot}" carries a malformed record version.`,
        });
        continue;
      }
      expectedVersion = Number(version) as RecordVersion;
    }
    refs.push({ param: slot, model: (rule.ref as { readonly model: ModelName }).model, id: id as RecordId, expectedVersion });
  }
}

/** One rule in descriptor order: omission fill, array shape, then ref slots. */
function validateOnePreparedRule(
  rule: PreparedInputRule,
  inputs: ClosedInputs,
  normalized: Record<string, unknown>,
  refs: PendingRef[],
  fields: FieldError[],
): void {
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
      appendInputArrayLengthErrors(fields, param, 0, rule.min, rule.max);
    }
    return;
  }
  const outer = inputs[param];
  if (rule.arrayCheck && outer !== null) {
    if (!Array.isArray(outer)) {
      fields.push({ path: `/${param}`, code: 'invalid_array', message: `Input "${param}" must be an array.` });
      return;
    }
    if (appendInputArrayLengthErrors(fields, param, outer.length, rule.min, rule.max)) return;
    // Empty arrays need no element wire parsing.
    if (outer.length === 0) return;
  }
  if (rule.ref === null) return;
  const supplied = inputs[param];
  if (supplied === null && Object.hasOwn(rule.ref, 'nullable') && rule.ref.nullable === true) {
    return;
  }
  validatePreparedRefSlots(rule, param, supplied, refs, fields);
}

export function validatePreparedInputs(
  plan: PreparedOperationPlan,
  inputs: ClosedInputs | OwnedJsonToken,
): ValidatedCallInputs {
  if (inputs instanceof OwnedJsonToken) {
    const owned: unknown = readOwnedJson(inputs).value;
    if (typeof owned !== 'object' || owned === null || Array.isArray(owned)) {
      throw new Error('validatePreparedInputs: owned inputs must resolve to an object.');
    }
    return validatePreparedRecord(plan, owned as ClosedInputs);
  }
  return validatePreparedRecord(plan, inputs);
}

function validatePreparedRecord(
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
    validateOnePreparedRule(rule, inputs, normalized, refs, fields);
  }
  if (fields.length > 0) {
    throw new StateError('validation', 'Invalid operation inputs.', null, { fields });
  }
  return { refs, normalized };
}
