/**
 * `DeliveryError` construction and redaction (DESIGN section 8).
 *
 * The error payload stays the closed `{code, message}` shape. Provider
 * specificity selects only fixed adapter-owned explanations. Arbitrary
 * provider text falls back to a generic classification/explanation;
 * surviving a text scrub does not establish safe disclosure.
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

const SPECIFIC_EXPLANATIONS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  ['Mail delivery rejected by provider.', new Map([
    ['Unknown recipient domain', 'Unknown recipient domain'],
    ['No mailbox here', 'No mailbox here'],
    ['No mailbox for recipient', 'No mailbox for recipient'],
  ])],
  ['Model provider reported an error mid-stream.', new Map([
    ['model overloaded, try again', 'model overloaded, try again'],
  ])],
  ['Image provider reported run failure.', new Map([
    ['VAE decode failed', 'VAE decode failed'],
  ])],
]);

/**
 * Match bounded provider evidence exactly within the adapter's authored
 * fallback category. Return fixed explanations, never provider text;
 * unknown or modified evidence falls back to the trusted generic.
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
  return SPECIFIC_EXPLANATIONS.get(generic)?.get(raw) ?? generic;
}
