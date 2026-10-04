/**
 * Structured error logging over the `Logger` port.
 *
 * Business rejections are routine (no stack, `info` level); unexpected
 * failures log at `error` with redacted detail under an incident id that
 * callers can quote to support. No `node:*` imports: this module must run
 * in workerd as well as Node.
 */
import type { BusinessError } from '@canlang/contracts';
import type { Logger } from '../ports.js';
import { redactForLog } from './redact.js';

/**
 * Console-backed logger: one JSON line per call, `level` + `message` plus
 * the fields object. `error` goes to `console.error`, else `console.log`.
 */
export function createConsoleLogger(): Logger {
  return {
    log(level, message, fields) {
      const line = JSON.stringify({ ...fields, level, message });
      if (level === 'error') {
        console.error(line);
      } else {
        console.log(line);
      }
    },
  };
}

/** Random 8-hex-char incident id from the Web Crypto RNG. */
export function incidentId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Log a business rejection at `info`: business errors are routine
 * outcomes, so there is no stack and the safe envelope members ride along.
 * Caller fields are redacted like the internal path: callers routinely
 * attach request context that may carry secrets.
 */
export function logBusinessError(
  logger: Logger,
  error: BusinessError,
  fields?: Record<string, unknown>,
): void {
  const redacted = redactForLog({
    ...fields,
    code: error.code,
    ...(error.operation_id !== undefined ? { operation_id: error.operation_id } : {}),
    ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
  });
  logger.log('info', `${error.code}: ${error.message}`, redacted as Record<string, unknown>);
}

/**
 * Log an unexpected failure at `error` with redacted detail, returning the
 * incident id (also included in the logged fields) for support correlation.
 * Pair with `fromUnknown`, which builds the safe caller-facing envelope.
 *
 * Residual risk (acknowledged): keyed redaction cannot catch secrets
 * embedded inside `err.message` text. Never interpolate secrets, tokens, or
 * credentials into thrown messages; value-scrubbing is out of scope.
 */
export function logInternalError(
  logger: Logger,
  err: unknown,
  fields?: Record<string, unknown>,
): string {
  const incident_id = incidentId();
  const detail =
    err instanceof Error ? { name: err.name, message: err.message } : { value: err };
  const redacted = redactForLog({ ...fields, detail });
  logger.log('error', `internal error (incident ${incident_id})`, {
    ...(redacted as Record<string, unknown>),
    incident_id,
  });
  return incident_id;
}
