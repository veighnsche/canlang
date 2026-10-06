import type { Violation } from "@canlang/contracts/values";

/** Evaluation-failure codes for checked values. These are never business codes. */
export type ValueFailureCode =
  | "overflow"
  | "division-by-zero"
  | "inexact"
  | "currency-mismatch"
  | "unknown-currency"
  | "invalid-construction"
  | "nonexistent-time"
  | "fold-required"
  | "out-of-range"
  | "limit-exceeded";

/**
 * A checked-value evaluation failure (overflow, rounding, constructor,
 * gap/fold, ...). Distinct from SchemaError and from business `error(code)`:
 * neither a ValueError nor a SchemaError can satisfy a BDD business error.
 */
export class ValueError extends Error {
  readonly kind = "value" as const;
  readonly code: ValueFailureCode;

  constructor(code: ValueFailureCode, message: string) {
    super(message);
    this.name = "ValueError";
    this.code = code;
  }
}

/**
 * A schema/shape/setup failure carrying structured violations. Callers
 * (lane-3 admission, lane-7 fixtures) map violations to their own envelopes;
 * this class itself is never a business error.
 */
export class SchemaError extends Error {
  readonly kind = "schema" as const;
  readonly violations: readonly Violation[];

  constructor(violations: readonly Violation[], message?: string) {
    super(message ?? `schema validation failed with ${violations.length} violation(s)`);
    this.name = "SchemaError";
    this.violations = Object.freeze([...violations]);
  }
}

/**
 * The closed `{code,message}` delivery error value and its maker/guard were
 * removed here: lane 04 owns `DeliveryError` in `services.ts` (single
 * definition; L7 handoff resolved by this removal).
 */
