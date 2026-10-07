/**
 * V02.5 prepared ordinary-MCP framing/binding plan (input-validation
 * profile `mcp-ordinary/v1`).
 *
 * A prepared plan freezes, for one checked operation, the exact
 * evaluation the MCP server performs on ordinary-mode tool arguments
 * (`invokeOrdinaryMode`, `mcp/server.ts`): host mutation-ID framing
 * first (mutation kinds only; `operation_id` validated then stripped
 * — reads carry none, so a present one fails closed as an unknown
 * member), then the catalog closed-inputs check, then the
 * MCP-SPECIFIC ref/shape checks in descriptor field order (keyed on
 * each field's `requireVersion`, with explicit nulls on
 * derived-declared refs deferred to binding), then derived binding
 * (first failure in derived-input declaration order, present members
 * only). The runner below delegates every stage to the canonical
 * checkers through their public boundaries — it reorders nothing,
 * re-derives nothing, and invents no parallel rule.
 *
 * MCP-specific ref rules (pinned here, absent from HTTP framing): ref
 * values carry EXACT keys (`{id}` / `{id, version}` — extras fail),
 * ids are non-empty strings of at most 256 UTF-16 units, versions
 * are arbitrary-digit canonical strings (`^[0-9]+$`, JSON numbers
 * fail). Handle mode (sealed `action_handle` orchestration) is OUT
 * of plan scope: the sealed host path is preserved untouched, and
 * the plan never sees a handle-bearing call.
 *
 * Provenance: SDK argument provenance is UNPROVEN (V01.1) — the plan
 * works over owned inputs only and records `sdkProvenance:
 * 'deferred'`. Defaults are NEVER applied: the plan carries no
 * default values, and a successful run returns the submitted
 * business inputs verbatim.
 */
import type {
  BusinessError,
  ClosedInputs,
  DerivedOperationInputs,
} from '@canlang/contracts';
import type {
  InterfacesClock,
  McpNamedField,
  OperationDescriptor,
  OperationInputShape,
} from '../ports.js';
import { toBindingEntry } from '../internal/prepared-binding.js';
import { buildBusinessError } from '../errors/envelope.js';
import { checkClosedInputs, validateOperationId } from '../envelope/validate.js';
import type { PreparedBindingEntry } from '../envelope/prepared.js';
import { MAX_ID_LENGTH, parseMutationRef, parseReadRef } from '../envelope/refs.js';
import { checkBoundArguments, isMutationKind } from './schemas.js';

/**
 * One prepared MCP ref rule: descriptor-order entry carrying the
 * MCP-specific shape contract (exact keys, UTF-16 id bound,
 * arbitrary-digit versions) for a single `ref` field.
 */
export interface PreparedMcpRefRule {
  readonly name: string;
  readonly versioned: boolean;
  readonly idMaxUtf16: number;
  readonly versionRule: 'arbitrary-digits';
  readonly exactKeys: readonly string[];
}

/**
 * Frozen prepared plan for one operation's ordinary-mode call:
 * `allowed`/`required` in dispatch shape order, `refs` in descriptor
 * field order, `binding` in derived declaration order, `defaults`
 * structurally absent, SDK provenance explicitly deferred, `derived`
 * retained for delegation to the canonical bound checker.
 */
export interface PreparedMcpPlan {
  readonly operation: string;
  readonly mutation: boolean;
  readonly allowed: readonly string[];
  readonly required: readonly string[];
  readonly refs: readonly PreparedMcpRefRule[];
  readonly binding: readonly PreparedBindingEntry[];
  readonly defaults: 'never-applied';
  readonly sdkProvenance: 'deferred';
  readonly derived: DerivedOperationInputs;
}

/** Prepared-plan run outcome: first error, or the framed call verbatim. */
export type PreparedMcpOutcome =
  | { readonly ok: true; readonly operation_id: string; readonly inputs: ClosedInputs }
  | { readonly ok: false; readonly error: BusinessError };


function toRefRule(field: McpNamedField): PreparedMcpRefRule {
  const versioned = field.field.kind === 'ref' && field.field.requireVersion === true;
  return Object.freeze({
    name: field.name,
    versioned,
    idMaxUtf16: MAX_ID_LENGTH,
    versionRule: 'arbitrary-digits',
    exactKeys: versioned ? Object.freeze(['id', 'version']) : Object.freeze(['id']),
  });
}

/**
 * Prepare the ordinary-mode plan for one operation from its registry
 * descriptor (ref/shape view), dispatch shape (catalog closed view),
 * and derived inputs (binding view — all from real checked
 * derivation). The derived view must name the same operation;
 * anything else is caller misuse and throws rather than preparing a
 * mismatched plan.
 */
export function prepareMcpPlan(
  descriptor: OperationDescriptor,
  shape: OperationInputShape,
  derived: DerivedOperationInputs,
): PreparedMcpPlan {
  if (derived.operation !== descriptor.name) {
    throw new Error(
      `prepareMcpPlan: derived inputs name ${JSON.stringify(derived.operation)}, not ${JSON.stringify(descriptor.name)}.`,
    );
  }
  return Object.freeze({
    operation: descriptor.name,
    mutation: isMutationKind(descriptor.kind),
    allowed: Object.freeze([...shape.allowed]),
    required: Object.freeze([...shape.required]),
    refs: Object.freeze(
      descriptor.inputs.fields.filter((named) => named.field.kind === 'ref').map(toRefRule),
    ),
    binding: Object.freeze(derived.inputs.map(toBindingEntry)),
    defaults: 'never-applied',
    sdkProvenance: 'deferred',
    derived,
  });
}

/**
 * Run one prepared plan against submitted tool arguments: mutation-ID
 * framing, closed inputs, MCP ref-shape checks (descriptor order,
 * nulls on derived-declared refs deferred to binding), then derived
 * binding — the exact dispatch order, first error wins. Success
 * returns the framed `operation_id` (mutations; reads carry `''`)
 * and the business inputs object verbatim: raw, defaults never
 * filled. Sealed handle calls are not plan calls — `action_handle`
 * input throws (programmer misuse) instead of ever routing through
 * the ordinary stages.
 */
export function runPreparedMcpPlan(
  plan: PreparedMcpPlan,
  args: Record<string, unknown>,
  clock?: InterfacesClock,
): PreparedMcpOutcome {
  if (Object.prototype.hasOwnProperty.call(args, 'action_handle')) {
    throw new Error('runPreparedMcpPlan: sealed handle calls take the handle-mode path, never the ordinary plan.');
  }
  let operationId = '';
  if (plan.mutation) {
    const raw: unknown = args['operation_id'];
    if (typeof raw !== 'string') {
      return { ok: false, error: buildBusinessError('validation', 'Missing operation_id.') };
    }
    const idError = validateOperationId(raw, clock);
    if (idError !== null) return { ok: false, error: idError };
    operationId = raw;
  }
  const businessInputs: ClosedInputs = { ...args };
  if (plan.mutation) delete businessInputs['operation_id'];
  const shape: OperationInputShape = { allowed: [...plan.allowed], required: [...plan.required] };
  const framingError = checkClosedInputs(businessInputs, shape);
  if (framingError !== null) return { ok: false, error: framingError };
  const derivedNames = new Set(plan.derived.inputs.map((input) => input.name));
  for (const rule of plan.refs) {
    if (!Object.prototype.hasOwnProperty.call(businessInputs, rule.name)) continue;
    const value: unknown = businessInputs[rule.name];
    if (value === null && derivedNames.has(rule.name)) continue;
    if (rule.versioned) {
      const parsed = parseMutationRef(value, `/${rule.name}`);
      if ('error' in parsed) return { ok: false, error: parsed.error };
    } else {
      const parsed = parseReadRef(value);
      if ('error' in parsed) return { ok: false, error: parsed.error };
    }
  }
  const boundError = checkBoundArguments(plan.derived, businessInputs);
  if (boundError !== null) return { ok: false, error: boundError };
  return { ok: true, operation_id: operationId, inputs: businessInputs };
}
