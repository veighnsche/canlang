import type { DeliveryError, Violation } from "../../contracts/src/values.js";

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
    this.violations = violations;
  }
}

/** Closed `{code,message}` delivery error value (DESIGN §8). */
export function makeDeliveryError(code: string, message: string): DeliveryError {
  if (typeof code !== "string" || code.length === 0) {
    throw new ValueError("invalid-construction", "DeliveryError code must be non-empty");
  }
  if (typeof message !== "string" || message.length === 0) {
    throw new ValueError("invalid-construction", "DeliveryError message must be non-empty");
  }
  return Object.freeze({ code, message });
}

export function isDeliveryError(value: unknown): value is DeliveryError {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["code"] === "string" && typeof record["message"] === "string";
}
