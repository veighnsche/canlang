/**
 * Allowlist field projection (lane 06, S3; DESIGN section 4 leaf grants).
 *
 * The MECHANISM lives here; L3 supplies the granted leaf paths per policy.
 * L6 never invents grants: every path comes from checked policy output.
 *
 * Rules:
 * - `grantedLeafPaths` are dot-separated leaf paths (e.g.
 *   `'notification.status'`); singular embedded objects are traversed.
 * - Empty grant list -> `{}`.
 * - Unknown paths (a segment naming an absent key) and unsupported paths
 *   (malformed segments, descent through an array/primitive, `__proto__`)
 *   throw `Error`: grants come from checked policies, never user input, so
 *   any grant/record mismatch is a programmer/compile error.
 * - Arrays (and model refs, files, secrets, actions: anything that is not
 *   a singular embedded object) are traversed ONLY as whole-leaf values
 *   when the exact path names them. There is NO descent into arrays: a
 *   grant continuing past an array-valued segment throws. Leaf values are
 *   cloned structurally, so whole-leaf objects/arrays share no references
 *   with the input.
 * - Denied leaves are OMITTED (never null-filled). An authorized null
 *   prefix serializes null (`{n: null}` for grant `'n.status'`), and
 *   granted null/primitive values pass through.
 * - A parent grant subsumes descendants (`'a'` covers `'a.b'`); grants are
 *   applied parent-first so the result never depends on grant order.
 * - The result is a fresh object graph (no input aliasing) for JSON-ish
 *   typed values: arrays and plain objects are cloned recursively;
 *   primitives pass through. Exotic host objects (Date, Map, ...) are out
 *   of contract and pass by reference.
 */
/**
 * True when `path` is covered by the grants: exact match or a granted
 * segment-wise parent (mirrors `projectFields` subsumption).
 */
export function hasGrantedPath(grantedLeafPaths: readonly string[], path: string): boolean {
  return grantedLeafPaths.some(
    (grant) => grant === path || (path.length > grant.length && path.startsWith(`${grant}.`)),
  );
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Structural clone for JSON-ish values (see module doc for the boundary).
 * Records are acyclic-by-contract; the depth cap turns a contract violation
 * (cyclic input) into a clean Error instead of stack exhaustion.
 */
const CLONE_MAX_DEPTH = 20;

function cloneValue(value: unknown, depth = 0): unknown {
  if (depth > CLONE_MAX_DEPTH) {
    throw new Error('Cannot project value: exceeds maximum nesting depth.');
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const cloned = cloneValue(value[key], depth + 1);
      if (key === '__proto__') {
        // defineProperty: plain assignment would set the prototype.
        Object.defineProperty(out, key, {
          value: cloned,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        out[key] = cloned;
      }
    }
    return out;
  }
  return value;
}

interface ParsedGrant {
  readonly raw: string;
  readonly segments: readonly string[];
}

/** Parse one grant path; malformed grants are programmer errors (throw). */
function parseGrant(grant: string): ParsedGrant {
  if (typeof grant !== 'string' || grant.length === 0) {
    throw new Error('Invalid grant path: expected a non-empty string.');
  }
  const segments = grant.split('.');
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error(`Invalid grant path '${grant}': empty segment.`);
  }
  if (segments.some((segment) => segment === '__proto__')) {
    throw new Error(`Invalid grant path '${grant}': reserved segment.`);
  }
  return { raw: grant, segments };
}

/** True when `parent` is a strict segment-wise prefix of `child`. */
function isPrefixGrant(parent: string, child: string): boolean {
  return child.length > parent.length && child.startsWith(parent + '.');
}

/** Project one parsed grant from `record` into `out` (both plain objects). */
function projectOne(
  record: Record<string, unknown>,
  out: Record<string, unknown>,
  grant: ParsedGrant,
): void {
  let src: Record<string, unknown> = record;
  let dst: Record<string, unknown> = out;
  const last = grant.segments.length - 1;
  for (const [index, key] of grant.segments.entries()) {
    if (!hasOwn(src, key)) {
      throw new Error(`Unknown grant path '${grant.raw}': '${key}' is not present.`);
    }
    const value: unknown = src[key];
    if (index === last) {
      dst[key] = cloneValue(value);
      return;
    }
    if (value === null) {
      // Authorized null prefix serializes null (DESIGN section 4).
      dst[key] = null;
      return;
    }
    if (!isPlainObject(value)) {
      throw new Error(`Unsupported grant path '${grant.raw}': cannot descend into '${key}'.`);
    }
    const existing: unknown = dst[key];
    if (existing !== undefined && !isPlainObject(existing)) {
      // Unreachable: a whole value at a strict prefix means an exact or
      // prefix grant was already applied, and such grants are skipped.
      throw new Error(`Unsupported grant path '${grant.raw}': internal prefix conflict.`);
    }
    const child: Record<string, unknown> = isPlainObject(existing) ? existing : {};
    dst[key] = child;
    src = value;
    dst = child;
  }
}

export function projectFields(
  record: Record<string, unknown>,
  grantedLeafPaths: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (grantedLeafPaths.length === 0) {
    return out;
  }
  // Parent-first (then lexical) so subsumption never depends on grant order.
  const ordered = grantedLeafPaths
    .map(parseGrant)
    .sort(
      (a, b) => a.segments.length - b.segments.length || (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0),
    );
  const done: string[] = [];
  for (const grant of ordered) {
    if (done.some((applied) => applied === grant.raw || isPrefixGrant(applied, grant.raw))) {
      continue; // Exact duplicate or subsumed by an applied parent grant.
    }
    projectOne(record, out, grant);
    done.push(grant.raw);
  }
  return out;
}
