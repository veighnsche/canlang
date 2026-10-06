/**
 * `DeliveryError` construction and redaction (DESIGN section 8).
 *
 * The error payload stays the closed `{code, message}` shape. Provider
 * bytes are never embedded raw: tokens, credentials, bodies, stack
 * traces and account data are stripped, and provider specificity is
 * used only when it survives redaction untouched; otherwise a generic
 * classification/explanation is used.
 */
import type { DeliveryError } from '@canlang/contracts';

/** Build the closed error payload: exactly `code` and `message`. */
export function deliveryError(code: string, message: string): DeliveryError {
  return { code, message };
}

const STACK_FRAME = /^[ \t]*at[ \t].*$/gm;
const BEARER = /\bBearer\s+[A-Za-z0-9\-._~+/=]+/g;
const BASIC = /\bBasic\s+[A-Za-z0-9+/=]+/g;
const CREDENTIAL_ASSIGN =
  /\b(api[_-]?key|password|passwd|pwd|secret|client[_-]?secret|token|session[_-]?token|credential[s]?)\s*[:=]\s*['"]?[^\s'";,}]+/gi;
const API_TOKEN = /\b(sk|ghp|gho|xox[baprs]|AKIA)[A-Za-z0-9\-_]+/g;
const JWT =
  /\beyJ[A-Za-z0-9\-_]{1,512}\.[A-Za-z0-9\-_]{1,2048}\.[A-Za-z0-9\-_]{0,2048}\b/g;
const ACCOUNT_ID = /\bacct_[A-Za-z0-9]+\b/g;

/** Scrub untrusted text of tokens, credentials, traces, account data. */
export function redactUntrusted(text: string): string {
  return text
    .replace(STACK_FRAME, '[REDACTED]')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(BASIC, 'Basic [REDACTED]')
    .replace(CREDENTIAL_ASSIGN, '$1=[REDACTED]')
    .replace(API_TOKEN, '[REDACTED]')
    .replace(JWT, '[REDACTED]')
    .replace(ACCOUNT_ID, 'acct_[REDACTED]');
}

/**
 * Use provider-supplied specificity only when it is a short single-line
 * string that redaction leaves byte-identical; otherwise fall back to
 * the generic explanation. Any sign of sensitive content discards the
 * whole message rather than leaking its structure.
 */
export function specificOrGeneric(
  raw: unknown,
  generic: string,
  maxLength = 200,
): string {
  if (typeof raw !== 'string') {
    return generic;
  }
  if (raw.length === 0 || raw.length > maxLength) {
    return generic;
  }
  if (raw.includes('\n') || raw.includes('\r') || raw.includes('\0')) {
    return generic;
  }
  const redacted = redactUntrusted(raw);
  if (redacted !== raw) {
    return generic;
  }
  return redacted;
}
