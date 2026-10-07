/**
 * V02.2 plan-scoped values AST codec (TS side).
 *
 * Admission, not reimplementation: every entry point resolves a live V02.1
 * owner plan, walks the parsed type-id AST for plan coverage, then delegates
 * the actual conversion to the canonical legacy converters (`decodeValue` /
 * `encodeValue` in `wire.ts`) through non-dispatching private cores. These remain explicit preparation
 * gates, not production owner/request admission. The codec
 * reorders nothing, re-derives nothing, and invents no parallel wire rule —
 * the whole-call comparator in `validation.ts` proves call-by-call that the
 * prepared path agrees with the direct legacy path.
 *
 * Coverage: scalar/stringlike leaves and self-contained bases (`user`,
 * `member`, `file`, `secret`, `json`, inline `enum(...)`) are covered under
 * any live plan. Nominal roots (`nominal`, `union` arms) must name plan
 * contracts or enums by exact match — dotted paths abstain (retained limit:
 * the plan registry keys top-level names only). `action`/`invocation`
 * targets and `delivery` operations name plan operations. Anything else —
 * invalid type ids, unknown nominal names, foreign owners, unknown or
 * released plans — fails closed with `PlanError` and stays on the legacy
 * codec, which this module never touches: hand-built schemas and unknown
 * encode/decode keep full legacy scope.
 *
 * All behavior is synchronous. Error-layering note: `PlanErrorCode` is
 * closed in `plan.ts` (V02.2 is CREATE-scope and must not extend it), so
 * coverage abstention reuses `unknown-plan` with a precise message; a
 * future `unknown-type` code is a retained followup once `plan.ts` is open
 * for extension.
 */
import type { CanValue, WireValue } from "@canlang/contracts/values";
import { decodeValueTsCore, encodeValueTsCore } from "../internal/wire-core.js";
import type { NormalizedType } from "../types.js";
import { parseTypeId } from "../types.js";
import type { PreparedValidationPlan } from "./plan.js";
import { getValidationPlan, PlanError } from "./plan.js";

// ---------------------------------------------------------------------------
// Coverage walk over the parsed type-id AST.
// ---------------------------------------------------------------------------

function nominalCovered(plan: PreparedValidationPlan, name: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(plan.contracts, name) ||
    Object.prototype.hasOwnProperty.call(plan.enums, name)
  );
}

function operationCovered(plan: PreparedValidationPlan, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(plan.operations, name);
}

/**
 * True exactly when a live plan covers a parsed type AST: every nominal
 * root resolves to a plan contract/enum and every action/invocation
 * target and delivery operation resolves to a plan operation. Scalar and
 * self-contained bases need no plan member. Never throws.
 */
export function isPlanCoveredType(plan: PreparedValidationPlan, typeId: string): boolean {
  let type: NormalizedType;
  try {
    type = parseTypeId(typeId);
  } catch {
    return false;
  }
  const base = type.base;
  switch (base.kind) {
    case "scalar":
    case "stringlike":
    case "user":
    case "member":
    case "file":
    case "secret":
    case "json":
    case "enum":
      return true;
    case "nominal":
      return nominalCovered(plan, base.path);
    case "union":
      return base.arms.every((arm) => nominalCovered(plan, arm));
    case "action":
    case "invocation":
      return base.targets === null || base.targets.every((target) => operationCovered(plan, target));
    case "delivery":
      return base.operation === null || operationCovered(plan, base.operation);
    default: {
      const _exhaustive: never = base;
      return void _exhaustive as unknown as false;
    }
  }
}

function coveredPlanOrThrow(owner: unknown, id: unknown, typeId: string, what: string): void {
  const plan = getValidationPlan(owner, id);
  if (typeof typeId !== "string" || !isPlanCoveredType(plan, typeId)) {
    throw new PlanError(
      "unknown-plan",
      `${what} abstains: type ${JSON.stringify(typeId)} is not covered by this plan (legacy codec keeps full scope)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Plan-gated codec entry points.
// ---------------------------------------------------------------------------

/**
 * Decode wire data to a canonical value under a live plan: owner + plan
 * admission, type-AST coverage, then the canonical legacy `decodeValue`.
 * Admission failures throw `PlanError` (caller stays on legacy); conversion
 * failures throw the legacy error verbatim.
 */
export function decodePreparedValue(
  owner: unknown,
  id: unknown,
  typeId: string,
  wire: unknown,
): CanValue {
  coveredPlanOrThrow(owner, id, typeId, "decodePreparedValue");
  return decodeValueTsCore(typeId, wire);
}

/**
 * Encode a canonical value to wire data under a live plan: owner + plan
 * admission, type-AST coverage, then the canonical legacy `encodeValue`.
 * Admission failures throw `PlanError` (caller stays on legacy); conversion
 * failures throw the legacy error verbatim.
 */
export function encodePreparedValue(
  owner: unknown,
  id: unknown,
  typeId: string,
  value: CanValue,
): WireValue {
  coveredPlanOrThrow(owner, id, typeId, "encodePreparedValue");
  return encodeValueTsCore(typeId, value);
}
