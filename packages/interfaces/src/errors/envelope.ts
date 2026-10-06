/**
 * Business error envelope constructors and transport projections.
 *
 * The envelope has the same meaning over HTTP, HTMX fragments, and MCP
 * (MCP: `isError=true`); protocol errors stay JSON-RPC errors, and
 * existence-hiding lookups surface as `not_found` (DESIGN section 10).
 */
import { BUSINESS_ERROR_HTTP_STATUS } from '@canlang/contracts';
import type { BusinessError, BusinessErrorCode, ConflictCurrent, FieldError } from '@canlang/contracts';
import { PUBLIC_ERROR_MESSAGES } from './safe.js';

/** Optional envelope members for {@link buildBusinessError}. */
export interface BuildBusinessErrorOptions {
  readonly operation_id?: string;
  readonly fields?: readonly FieldError[];
  readonly retryable?: boolean;
  /** L3-carried conflict current; meaningful only on `conflict` codes. */
  readonly conflict?: ConflictCurrent;
}

/** Codes whose default is retryable: repeating the identical envelope may succeed. */
const DEFAULT_RETRYABLE_CODES: ReadonlySet<BusinessErrorCode> = new Set([
  'busy',
  'delivery_unknown',
]);

/**
 * Build a business error envelope. The message defaults to the generic
 * safe text for the code; `retryable` defaults to true only for
 * `busy`/`delivery_unknown`, else false unless explicitly passed.
 */
export function buildBusinessError(
  code: BusinessErrorCode,
  message?: string,
  opts?: BuildBusinessErrorOptions,
): BusinessError {
  const retryable = opts?.retryable ?? DEFAULT_RETRYABLE_CODES.has(code);
  return {
    code,
    message: message ?? PUBLIC_ERROR_MESSAGES[code],
    ...(opts?.operation_id !== undefined ? { operation_id: opts.operation_id } : {}),
    ...(opts?.fields !== undefined ? { fields: opts.fields } : {}),
    retryable,
    ...(opts?.conflict !== undefined ? { conflict: opts.conflict } : {}),
  };
}

/** Canonical HTTP status for a business error code (contract table). */
export function httpStatusFor(code: BusinessErrorCode): number {
  return BUSINESS_ERROR_HTTP_STATUS[code];
}

/** HTTP projection: status plus the BusinessError JSON as the body. */
export function toHttpResponse(error: BusinessError): {
  status: number;
  body: BusinessError;
} {
  return { status: httpStatusFor(error.code), body: error };
}

/** MCP text content block. */
export interface McpTextContent {
  readonly type: 'text';
  readonly text: string;
}

/** MCP tool-error projection: `isError=true` with the envelope attached. */
export interface McpError {
  readonly isError: true;
  readonly content: readonly McpTextContent[];
  readonly structuredContent: BusinessError;
}

/**
 * Maximum field details inlined into MCP text before a count note.
 * Lane-06 authored bound (DESIGN pins isError + same meaning, not text
 * length); the full envelope always rides in structuredContent.
 */
export const MCP_MAX_INLINE_FIELDS = 5;

/**
 * MCP projection: `${code}: ${message}` plus '; path: msg' joins for the
 * first fields, bounded to {@link MCP_MAX_INLINE_FIELDS} with a '…'
 * count note for the remainder.
 */
export function toMcpError(error: BusinessError): McpError {
  let text = `${error.code}: ${error.message}`;
  const fields = error.fields ?? [];
  for (const field of fields.slice(0, MCP_MAX_INLINE_FIELDS)) {
    text += `; ${field.path}: ${field.message}`;
  }
  if (fields.length > MCP_MAX_INLINE_FIELDS) {
    text += `; … and ${fields.length - MCP_MAX_INLINE_FIELDS} more`;
  }
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: error,
  };
}

/**
 * Convert an unexpected throw into a safe envelope.
 *
 * Lane-06 authored rule: unexpected failures become `rule_failed` with the
 * generic public message and `retryable: false`. They must not invent new
 * codes or leak caught detail (messages may carry secrets, SQL, or paths).
 * Pair with `logInternalError`, which journals the redacted detail under an
 * incident id for support correlation.
 */
export function fromUnknown(err: unknown, opts?: { operation_id?: string }): BusinessError {
  void err;
  return buildBusinessError('rule_failed', undefined, {
    ...(opts?.operation_id !== undefined ? { operation_id: opts.operation_id } : {}),
    retryable: false,
  });
}
