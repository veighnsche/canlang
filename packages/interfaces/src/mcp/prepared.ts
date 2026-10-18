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
import { OwnedJsonToken, ownedFrameFor, readOwnedJson } from '@canlang/values/bindings/owned-input';
import { resolveDeferredValidation } from '@canlang/values/bindings/validation';
import type { OwnedOperationValidation } from '../ports.js';
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
  readonly array?: true;
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
  /** Explicit installed owned-validation selection (`values/v1`) for
   * this operation: the installed native backend, the fixed
   * exact-codec capability, the registered owner/plan pair and the
   * admitted budgets. Absent keeps the legacy path. Supplied once at
   * preparation from the installed glue plus released plans — never
   * per call, never a test-only injection. */
  readonly owned?: OwnedOperationValidation;
}

/** Prepared-plan run outcome: first error, or the framed call verbatim. */
export type PreparedMcpOutcome =
  | { readonly ok: true; readonly operation_id: string; readonly inputs: ClosedInputs }
  | { readonly ok: false; readonly error: BusinessError };


function toRefRule(field: McpNamedField): PreparedMcpRefRule {
  const versioned = field.field.kind === 'ref' && field.field.requireVersion === true;
  return Object.freeze({
    name: field.name,
    ...(field.array === undefined ? {} : { array: true as const }),
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
  owned?: OwnedOperationValidation | null,
): PreparedMcpPlan {
  if (derived.operation !== descriptor.name) {
    throw new Error(
      `prepareMcpPlan: derived inputs name ${JSON.stringify(derived.operation)}, not ${JSON.stringify(descriptor.name)}.`,
    );
  }
  if (owned !== undefined && owned !== null && typeof owned.backend?.call !== 'function') {
    throw new Error('prepareMcpPlan: installed owned selection requires its native backend.');
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
    ...(owned === undefined || owned === null ? {} : { owned }),
  });
}

/**
 * Renders one native violation path as a JSON Pointer into the
 * submitted arguments (lossy display only, mirroring host formatting).
 */
function ownedPathToPointer(path: ReadonlyArray<{ k: readonly number[] } | { i: number }>): string {
  let out = '';
  for (const seg of path) {
    out += 'i' in seg ? `/${seg.i}` : `/${String.fromCharCode(...seg.k)}`;
  }
  return out === '' ? '/' : out;
}

/**
 * Runs the owned values/v1 gate for one ordinary-mode call: genuine
 * native execution with the deferred-leaf join over the parser-owned
 * arguments. Returns a validation denial for invalid and limit
 * outcomes, or null to continue the legacy stages (valid outcomes
 * and honestly unresolved deferrals alike, with value identity
 * unchanged). Only fires for genuine tokens with an installed plan
 * selection; plain SDK records keep their original disposition.
 */
function runOwnedMcpValidation(
  plan: PreparedMcpPlan,
  owned: OwnedOperationValidation,
  token: OwnedJsonToken,
  record: Record<string, unknown>,
): BusinessError | null {
  const outcome = resolveDeferredValidation(
    owned.backend,
    {
      owner: owned.owner,
      plan: owned.plan,
      frame: ownedFrameFor(token),
      budgets: owned.budgets,
      profile: 'values/v1',
      target: { kind: 'operation', name: plan.operation },
    },
    record,
    { exact: owned.exact },
  );
  if (outcome.outcome === 'invalid') {
    const fields = outcome.violations.map((violation) => ({
      path: ownedPathToPointer(violation.path),
      code: violation.code,
      message: violation.message,
    }));
    return buildBusinessError('validation', outcome.violations[0]?.message ?? 'Invalid inputs.', {
      fields,
    });
  }
  if (outcome.outcome === 'limit') {
    return buildBusinessError(
      'validation',
      `Owned validation refused: ${outcome.code} (${outcome.check}).`,
    );
  }
  return null;
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
  args: Record<string, unknown> | OwnedJsonToken,
  clock?: InterfacesClock,
): PreparedMcpOutcome {
  // Owned admission: a genuine parser-owned token resolves through its
  // lineage before the ordinary stages run. The resolved value is only
  // read and copied; forged tokens refuse at lineage resolution and
  // non-object resolutions are caller misuse. Scope, framing and
  // binding below are unchanged.
  const submitted: unknown =
    args instanceof OwnedJsonToken ? readOwnedJson(args).value : args;
  if (typeof submitted !== 'object' || submitted === null || Array.isArray(submitted)) {
    throw new Error('runPreparedMcpPlan: owned arguments must resolve to an object.');
  }
  const record = submitted as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'action_handle')) {
    throw new Error('runPreparedMcpPlan: sealed handle calls take the handle-mode path, never the ordinary plan.');
  }
  let operationId = '';
  if (plan.mutation) {
    const raw: unknown = record['operation_id'];
    if (typeof raw !== 'string') {
      return { ok: false, error: buildBusinessError('validation', 'Missing operation_id.') };
    }
    const idError = validateOperationId(raw, clock);
    if (idError !== null) return { ok: false, error: idError };
    operationId = raw;
  }
  // Owned values/v1 gate (token + installed selection only): genuine
  // native admission over the framed call (operation_id already
  // host-validated above for mutations) before the legacy
  // closed/ref-shape/binding stages. Invalid and limit outcomes deny
  // here; valid and honestly unresolved deferrals continue below with
  // value identity unchanged. Plain SDK records keep their original
  // disposition.
  if (args instanceof OwnedJsonToken && plan.owned !== undefined && plan.owned !== null) {
    const ownedError = runOwnedMcpValidation(plan, plan.owned, args, record);
    if (ownedError !== null) return { ok: false, error: ownedError };
  }
  const businessInputs: ClosedInputs = { ...record };
  if (plan.mutation) delete businessInputs['operation_id'];
  const shape: OperationInputShape = { allowed: [...plan.allowed], required: [...plan.required] };
  const framingError = checkClosedInputs(businessInputs, shape);
  if (framingError !== null) return { ok: false, error: framingError };
  const derivedNames = new Set(plan.derived.inputs.map((input) => input.name));
  for (const rule of plan.refs) {
    if (!Object.prototype.hasOwnProperty.call(businessInputs, rule.name)) continue;
    const value: unknown = businessInputs[rule.name];
    if (value === null && derivedNames.has(rule.name)) continue;
    const error = checkMcpRefShape(value, rule.name, rule.versioned, rule.array === true);
    if (error !== null) return { ok: false, error };
  }
  const boundError = checkBoundArguments(plan.derived, businessInputs);
  if (boundError !== null) return { ok: false, error: boundError };
  return { ok: true, operation_id: operationId, inputs: businessInputs };
}

/** Shared real/prepared MCP framing; bindings and row authority follow later. */
export function checkMcpRefShape(value: unknown, name: string, versioned: boolean, array: boolean): BusinessError | null {
  if (array && !Array.isArray(value)) {
    const message = `Input ${JSON.stringify(name)} must be an array.`;
    return buildBusinessError('validation', message, { fields: [{ path: `/${name}`, code: 'invalid_array', message }] });
  }
  const values = array ? value as unknown[] : [value];
  for (let index = 0; index < values.length; index += 1) {
    const path = `/${name}${array ? `/${index}` : ''}`;
    const parsed = versioned ? parseMutationRef(values[index], path) : parseReadRef(values[index]);
    if (!('error' in parsed)) continue;
    if (!array) return parsed.error;
    const message = `Input ${JSON.stringify(path)}: ${parsed.error.message}`;
    return buildBusinessError('validation', message, {
      fields: (parsed.error.fields ?? [{ path: '', code: 'invalid', message: parsed.error.message }]).map(field => ({
        ...field, path: versioned && field.path !== '' ? field.path : `${path}${field.path}`,
      })),
    });
  }
  return null;
}
