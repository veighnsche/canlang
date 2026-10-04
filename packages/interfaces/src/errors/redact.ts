/**
 * Log redaction: deep-clone untrusted values with secret-bearing members
 * replaced before journaling. Keyed redaction only — any object key
 * matching {@link SECRET_KEY_PATTERN} has its value replaced without
 * descent, so secret payloads never reach the log even in nested shape.
 */

/** Replacement for redacted values. */
export const REDACTED = '[redacted]';

/** Replacement for circular references. */
export const CIRCULAR = '[circular]';

/** Replacement for values deeper than the depth cap. */
export const DEPTH_EXCEEDED = '[depth]';

/** Fallback when a node cannot be inspected at all. */
export const UNSERIALIZABLE = '[unserializable]';

/**
 * Lane-06 authored secret-key list: keys matching any of these fragments
 * (case-insensitive) are treated as secret-bearing. Deliberately broad
 * (`auth` covers `authToken`, `clientAuth`, …); prefer over-redaction in
 * logs since redacted fields are still counted as present.
 */
export const SECRET_KEY_PATTERN =
  /token|secret|password|passwd|pwd|cookie|credential|authorization|auth|session|private|ssn|card/i;

/** Options for {@link redactForLog}. */
export interface RedactOptions {
  /** Maximum traversal depth; deeper values become '[depth]'. Default 6. */
  readonly maxDepth?: number;
}

/**
 * Deep-clone `value`, replacing secret-keyed members, circular refs, and
 * over-deep values. Primitives pass through. Never throws: a node that
 * cannot be inspected becomes '[unserializable]'.
 */
export function redactForLog(value: unknown, opts?: RedactOptions): unknown {
  const maxDepth = opts?.maxDepth ?? 6;
  const seen = new Set<object>();
  const walk = (node: unknown, depth: number): unknown => {
    try {
      if (node === null || typeof node !== 'object') {
        return node;
      }
      if (seen.has(node)) {
        return CIRCULAR;
      }
      if (depth >= maxDepth) {
        return DEPTH_EXCEEDED;
      }
      seen.add(node);
      try {
        if (Array.isArray(node)) {
          return node.map((item) => walk(item, depth + 1));
        }
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(node)) {
          out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : walk(child, depth + 1);
        }
        return out;
      } finally {
        seen.delete(node);
      }
    } catch {
      return UNSERIALIZABLE;
    }
  };
  return walk(value, 0);
}
