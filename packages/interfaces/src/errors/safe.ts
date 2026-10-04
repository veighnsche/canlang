/**
 * Safe public error vocabulary (DESIGN section 10: business errors carry
 * structured codes and actionable safe details).
 *
 * `PUBLIC_ERROR_MESSAGES` holds one generic, localizable-eligible message
 * per business error code. These messages must never contain internals
 * (SQL diagnostics, stack traces, tokens, credentials, or confidential
 * values); they are safe to surface over HTTP, HTMX fragments, and MCP.
 */
import { BUSINESS_ERROR_CODES } from '@canlang/contracts';
import type { BusinessErrorCode, FieldError } from '@canlang/contracts';

/** Generic safe message per business error code. No internals. */
export const PUBLIC_ERROR_MESSAGES: Record<BusinessErrorCode, string> = {
  validation: 'The submitted input was invalid. Check the highlighted fields and try again.',
  forbidden: 'You do not have permission to perform this action.',
  not_found: 'The requested item was not found or is not available.',
  conflict: 'The item changed since you loaded it. Refresh and try again.',
  rule_failed: 'The operation was rejected. Review the details and try again.',
  busy: 'The service is busy. Please try again shortly.',
  limit: 'A usage limit was reached. Please try again later.',
  delivery_unknown: 'The outcome could not be confirmed. Check again before retrying.',
};

/**
 * Construct one safe field-level failure. `path` is a JSON Pointer into
 * the submitted inputs and must start with '/'. A bad path is a programmer
 * error, so it throws a plain Error (never a wire error).
 */
export function fieldError(path: string, code: string, message: string): FieldError {
  if (!path.startsWith('/')) {
    throw new Error(`fieldError path must be a JSON Pointer starting with '/': ${path}`);
  }
  return { path, code, message };
}

/** Narrow an unknown value to the closed business error code set. */
export function isBusinessErrorCode(value: unknown): value is BusinessErrorCode {
  return (
    typeof value === 'string' &&
    (BUSINESS_ERROR_CODES as readonly string[]).includes(value)
  );
}
