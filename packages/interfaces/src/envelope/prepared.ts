/**
 * V02.3 prepared HTTP framing/binding plan (input-validation profile
 * `http-input/v1`).
 *
 * A prepared plan freezes, for one checked operation, the exact
 * evaluation the HTTP dispatch performs on business inputs
 * (`handleOperationRequest`, `http/operations.ts`): framing first
 * (first unknown key in JS enumeration order, then first missing
 * required field in shape order, both own-presence), then derived
 * binding (first failure in derived-input declaration order, present
 * members only). The runner below delegates both stages to the
 * canonical checkers through their public boundaries
 * (`checkClosedInputs`, `checkBoundArguments`) — it reorders nothing,
 * re-derives nothing, and invents no parallel rule.
 *
 * Presence (interfaces-owned, differs from values): a member is
 * present iff it is an OWN property of the submitted object — an
 * explicit `undefined` value still counts as present for the
 * required check. Explicit `null` binds only to `nullable`
 * declarations; array-element nulls pass binding through to L3
 * admission. Defaults are NEVER applied: the plan carries no default
 * values at all, and a successful run returns the submitted inputs
 * object unchanged (raw business inputs, verbatim).
 *
 * Deferrals (kept distinct, never unified): `string` and `boolean`
 * values carry no declared set to bind and pass to L3 admission
 * untouched; money binds the `{minor, currency}` shape plus minor
 * range and currency string-ness, while the currency CODE meaning
 * stays L3-owned. Each deferral has its own tag below.
 */
import type {
  BusinessError,
  ClosedInputs,
  DerivedOperationInputs,
  DerivedWritableInput,
} from '@canlang/contracts';
import { toBindingEntry } from '../internal/prepared-binding.js';
import type { OperationInputShape } from '../ports.js';
import { checkBoundArguments } from '../mcp/schemas.js';
import { checkClosedInputs } from './validate.js';

/**
 * What binding judges for one input vs what it defers to L3 admission:
 * `bound` (the value binds here), `string-values` / `boolean-values`
 * (no declared set — whole value deferred), `currency-code` (money
 * shape/minor bound here, currency code meaning deferred).
 */
export type PreparedDeferral = 'bound' | 'string-values' | 'boolean-values' | 'currency-code';

/** One prepared binding entry: declaration order, kind rule, deferral tag. No defaults carried. */
export interface PreparedBindingEntry {
  readonly name: string;
  readonly kind: DerivedWritableInput['kind'];
  readonly required: boolean;
  readonly nullable: boolean;
  readonly array: boolean;
  readonly versioned: boolean;
  readonly enumValues: readonly string[] | null;
  readonly deferral: PreparedDeferral;
}

/**
 * Frozen prepared plan for one operation: `allowed`/`required` in
 * dispatch shape order, `binding` in derived declaration order,
 * `defaults` structurally absent (`never-applied`), `derived`
 * retained for delegation to the canonical bound checker.
 */
export interface PreparedHttpPlan {
  readonly operation: string;
  readonly kind: DerivedOperationInputs['kind'];
  readonly artifactVersion: number;
  readonly allowed: readonly string[];
  readonly required: readonly string[];
  readonly binding: readonly PreparedBindingEntry[];
  readonly defaults: 'never-applied';
  readonly derived: DerivedOperationInputs;
}

/** Prepared-plan run outcome: first error, or the submitted inputs unchanged. */
export type PreparedHttpOutcome =
  | { readonly ok: true; readonly inputs: ClosedInputs }
  | { readonly ok: false; readonly error: BusinessError };


/**
 * Prepare the framing/binding plan for one operation from its dispatch
 * shape and derived inputs (both from real checked derivation). The
 * derived view must name the same operation; anything else is caller
 * misuse and throws rather than preparing a mismatched plan.
 */
export function prepareHttpPlan(
  operation: string,
  shape: OperationInputShape,
  derived: DerivedOperationInputs,
): PreparedHttpPlan {
  if (derived.operation !== operation) {
    throw new Error(
      `prepareHttpPlan: derived inputs name ${JSON.stringify(derived.operation)}, not ${JSON.stringify(operation)}.`,
    );
  }
  return Object.freeze({
    operation,
    kind: derived.kind,
    artifactVersion: derived.artifactVersion,
    allowed: Object.freeze([...shape.allowed]),
    required: Object.freeze([...shape.required]),
    binding: Object.freeze(derived.inputs.map(toBindingEntry)),
    defaults: 'never-applied',
    derived,
  });
}

/**
 * Run one prepared plan against submitted business inputs: framing
 * (`checkClosedInputs`) first, then binding (`checkBoundArguments`) —
 * the exact dispatch order, first error wins. Success returns the
 * submitted inputs object itself: raw, verbatim, defaults never
 * filled.
 */
export function runPreparedHttpPlan(plan: PreparedHttpPlan, inputs: ClosedInputs): PreparedHttpOutcome {
  const shape: OperationInputShape = { allowed: [...plan.allowed], required: [...plan.required] };
  const framingError = checkClosedInputs(inputs, shape);
  if (framingError !== null) return { ok: false, error: framingError };
  const boundError = checkBoundArguments(plan.derived, inputs);
  if (boundError !== null) return { ok: false, error: boundError };
  return { ok: true, inputs };
}
