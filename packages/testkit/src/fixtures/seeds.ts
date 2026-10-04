/**
 * Scenario-seed vocabulary (S8d decision, lane-07 PR15).
 *
 * `TableRowSpec.seed` holds scenario refs of the form
 * `<provider>:<scenario>` (e.g. `mail:send-retry-success`). Each ref
 * selects one L4-authored scenario table; the row scope plays back its
 * per-call outcomes. Both segments are strict lowercase kebab-case
 * (letter-start, no leading/trailing/double hyphens); anything else
 * fails loud at parse time so a typo can never silently select (or
 * miss) a scenario.
 */

export interface SeedRef {
  readonly provider: string;
  readonly scenario: string;
}

const SEGMENT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class SeedRefError extends Error {
  readonly ref: string;

  constructor(ref: string, reason: string) {
    super(`invalid seed ref ${JSON.stringify(ref)}: ${reason}`);
    this.name = "SeedRefError";
    this.ref = ref;
  }
}

function checkSegment(ref: string, label: string, value: string): void {
  if (value.length === 0) {
    throw new SeedRefError(ref, `${label} is empty`);
  }
  if (!SEGMENT.test(value)) {
    throw new SeedRefError(ref, `${label} must be lowercase kebab-case starting with a letter`);
  }
}

/** Parse one seed ref; throws `SeedRefError` on any deviation. */
export function parseSeedRef(ref: string): SeedRef {
  const parts = ref.split(":");
  if (parts.length !== 2) {
    throw new SeedRefError(ref, "expected exactly one ':' separating provider and scenario");
  }
  const [provider, scenario] = parts as [string, string];
  checkSegment(ref, "provider", provider);
  checkSegment(ref, "scenario", scenario);
  return { provider, scenario };
}

/** Parse every ref in a row's seed list; duplicates are rejected. */
export function parseSeedRefs(refs: readonly string[]): SeedRef[] {
  const seen = new Set<string>();
  return refs.map((ref) => {
    if (seen.has(ref)) {
      throw new SeedRefError(ref, "duplicate seed ref in one row");
    }
    seen.add(ref);
    return parseSeedRef(ref);
  });
}
