/**
 * P-C production `McpPermissions`: team-members policy over artifact
 * operations (replaces the deny-closed interim default for members).
 *
 * POLICY SOURCE (read this before touching admission): there is NO
 * per-operation L3 grant surface reachable from the worker — verified
 * by reading the tree:
 *
 * - L3 `state/policy/grants.ts` is ROW visibility (model -> `by`/`when`
 *   grants for the query engine), not operation admission.
 * - L3 per-operation `by` predicates (`mutation/crud.ts`
 *   `CrudDefsOptions.by`, evaluated by `policy/roles.ts evaluateBy`)
 *   exist at L3 but are unreachable from the worker: no def supplier
 *   feeds the assembled invoker (join J2 unlanded — the deny-closed
 *   header in `mcp-registry.ts` says the same).
 * - The artifact policy surface carries no per-operation rule:
 *   `ArtifactOperation` is exactly {name, kind, description, inputs}
 *   (`contracts/src/artifact.ts`), and `requires[]` names linked
 *   library capabilities, not authorization policy.
 *
 * So the owning policy this factory reads is the TEAM-MEMBERSHIP
 * policy: admission = DESIGN section 4 `members` predicate semantics
 * evaluated over the `ResolvedIdentity` admission facts (actor +
 * grant-bound team + ACTIVE membership in THAT team, principal
 * matched) AND a closed operation world from the artifact's P1
 * `operations[]` (unknown operations deny). The membership check
 * mirrors `evaluateBy('members')` (`state/policy/roles.ts`) exactly —
 * evaluated inline because the worker boundary forbids importing the
 * L3 evaluator, and semantics drift would be a security bug, so any
 * change here must re-verify against that function line by line.
 *
 * When the J2 join lands (operation -> `ByPredicate` table supplied
 * to the worker), this factory takes that table and evaluates each
 * operation's OWN predicate; until then every known operation admits
 * exactly the active members of the grant-bound team.
 *
 * NEVER fail-open: anonymous, app-only (team null), missing/removed
 * membership, foreign-team binding mismatch, principal mismatch,
 * malformed identities, and unknown operations ALL deny. Absent
 * `operations[]` denies everything (registry parity: the registry is
 * empty then too); malformed entries throw loud naming the entry
 * (registry parity: `createArtifactRegistry` fails the same way).
 *
 * Worker-safe: type-only imports, no `node:` builtins, pure
 * synchronous admission over the identity snapshot (re-resolved per
 * call by the MCP server, never cached here).
 */

import type { CompileArtifact, ResolvedIdentity } from "@canlang/contracts";
import type { McpPermissions } from "./mcp-registry.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(where: string, detail: string): never {
  throw new Error(`mcp-permissions: ${where} ${detail}`);
}

/**
 * Read the P1 `operations[]` names off the artifact. Absent -> empty
 * (deny-all, matching the empty registry); present-but-not-an-array
 * or malformed entries -> fail loud (contract violation, never
 * silently treated as supported). Mirrors `readArtifactOperations`
 * (`mcp-registry.ts`) name validation exactly.
 */
function knownOperationNames(artifact: CompileArtifact): ReadonlySet<string> {
  const raw: unknown = (artifact as unknown as { operations?: unknown }).operations;
  if (raw === undefined || raw === null) return new Set();
  if (!Array.isArray(raw)) {
    fail("operations", `must be an array (got ${typeof raw})`);
  }
  const names = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const where = `operations[${index}]`;
    if (!isRecord(entry)) fail(where, "must be an object");
    const name: unknown = entry["name"];
    if (typeof name !== "string" || name.length === 0) {
      fail(`${where}.name`, "must be a non-empty string");
    }
    if (names.has(name)) {
      fail("operations", `repeats operation ${JSON.stringify(name)}`);
    }
    names.add(name);
  }
  return names;
}

/**
 * DESIGN section 4 `members` admission over the resolved identity
 * (mirrors `evaluateBy('members')` in `state/policy/roles.ts`:
 * actor + team + membership all present, membership bound to THIS
 * team, status active), plus a principal match (membership.user_id
 * === actor.user_id) the L3 form gets for free from its ByContext
 * construction. Malformed input denies — never throws.
 */
function isTeamMember(identity: ResolvedIdentity): boolean {
  if (!isRecord(identity)) return false;
  const actor: unknown = identity["actor"];
  const team: unknown = identity["team"];
  const membership: unknown = identity["membership"];
  if (!isRecord(actor) || !isRecord(team) || !isRecord(membership)) return false;
  if (typeof actor["user_id"] !== "string") return false;
  if (typeof team["team_id"] !== "string") return false;
  if (membership["team_id"] !== team["team_id"]) return false;
  if (membership["user_id"] !== actor["user_id"]) return false;
  if (membership["status"] !== "active") return false;
  return true;
}

/**
 * Build the production members-policy permissions for one artifact.
 * `canDiscover` and `canCall` admit exactly the active members of
 * the grant-bound team on known operations; everything else denies.
 */
export function createMemberMcpPermissions(artifact: CompileArtifact): McpPermissions {
  const known = knownOperationNames(artifact);
  const admits = (identity: ResolvedIdentity, operation: string): boolean => {
    if (typeof operation !== "string" || !known.has(operation)) return false;
    return isTeamMember(identity);
  };
  return {
    canDiscover: (identity: ResolvedIdentity, operation: string): boolean =>
      admits(identity, operation),
    canCall: (identity: ResolvedIdentity, operation: string): boolean =>
      admits(identity, operation),
  };
}
