/**
 * P-C production MCP grant route: session cookie in, worker-minted MCP
 * grant out.
 *
 * Contract (PINNED: P-A dynamic-imports this shape): `handleMcpGrant`
 * serves production grant issuance over HTTP — request `POST`
 * `{client_id}`, success 200 `{token, grant_id, user_id, team_id}`
 * minted via the REAL `issueMcpGrant`, bound to the session's active
 * team. It follows the fixture `POST /__e2e/mcp-grant` session-cookie
 * pattern WITHOUT the test-only marker: this IS the production path
 * (P-A mounts it on the production grant URL).
 *
 * Auth: the `can_session` cookie resolves through real
 * `resolveIdentity` (session audience); the grant mints only for a
 * verified actor WITH an active team membership in a team. Failures
 * are safe + loud: 405 non-POST, 401 missing/invalid session, 403 no
 * active membership, 400 malformed body/client_id, 500 unexpected
 * (generic body after a console journal entry — the raw token is
 * NEVER stored or logged anywhere on this path).
 *
 * PRODUCER LOADING (worker boundary): identity functions load via
 * DYNAMIC import (same seam as `env-assembly.ts`); a missing producer
 * 500s loud naming the seam. `IdentityError` recognition is
 * cross-copy safe: `instanceof` first, then a structural fallback
 * (`name` + closed business-code set) so a P-B vendor-bundle copy
 * skew can never turn a safe 4xx into a 500 or vice versa — unknown
 * failures always 500 generic.
 *
 * Worker-safe: type-only imports, no `node:` builtins.
 */

import type { BusinessErrorCode, McpGrant, ResolvedIdentity } from "@canlang/contracts";
import type { IdentityStore } from "./env-assembly.js";

/** Identity package root (resolves via the workspace link + exports map). */
const IDENTITY_SPECIFIER = "@canlang/identity";

/**
 * Structural view of the identity functions this route needs. Shapes
 * mirror `packages/identity/src` exactly (`sessions/cookies.ts`
 * `parseSessionCookie`, `authentication/context.ts` `resolveIdentity`,
 * `authentication/grants.ts` `issueMcpGrant`, `ports.ts`
 * `IdentityError`); the live functions run behind this view in every
 * test, proving it at runtime.
 */
interface GrantIdentityProducer {
  parseSessionCookie(header: string | readonly string[] | undefined): string | null;
  resolveIdentity(
    store: unknown,
    input: { session_token?: string; mcp_grant_token?: string; team_id?: string },
  ): Promise<ResolvedIdentity>;
  issueMcpGrant(
    store: unknown,
    input: { user_id: string; team_id: string | null; client_id: string },
  ): Promise<{ token: string; grant: McpGrant }>;
  IdentityError: new (...args: never[]) => Error;
}

/** Closed business-code set (`contracts/src/wire.ts` `BUSINESS_ERROR_CODES`). */
const BUSINESS_CODES: ReadonlySet<string> = new Set([
  "validation",
  "forbidden",
  "not_found",
  "conflict",
  "rule_failed",
  "busy",
  "limit",
  "delivery_unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadIdentity(): Promise<GrantIdentityProducer> {
  let mod: unknown;
  try {
    mod = await import(IDENTITY_SPECIFIER);
  } catch {
    throw new Error(
      `mcp-grant: identity producer is not assembled (${IDENTITY_SPECIFIER}); ` +
        `build @canlang/identity dist (root build) or stage the P-B vendor seam`,
    );
  }
  if (
    !isRecord(mod) ||
    typeof mod["parseSessionCookie"] !== "function" ||
    typeof mod["resolveIdentity"] !== "function" ||
    typeof mod["issueMcpGrant"] !== "function" ||
    typeof mod["IdentityError"] !== "function"
  ) {
    throw new Error(
      `mcp-grant: identity module lacks parseSessionCookie/resolveIdentity/issueMcpGrant/IdentityError (stale dist?)`,
    );
  }
  return mod as unknown as GrantIdentityProducer;
}

/**
 * Recognize an `IdentityError` across bundle copies: `instanceof`
 * against the loaded copy, else the structural invariant (error name
 * + closed business code). Anything else is unexpected and 500s.
 */
function readIdentityFailure(
  producer: GrantIdentityProducer,
  err: unknown,
): { code: BusinessErrorCode; message: string } | null {
  if (err instanceof producer.IdentityError) {
    const code: unknown = (err as unknown as Record<string, unknown>)["code"];
    if (typeof code === "string" && BUSINESS_CODES.has(code)) {
      return { code: code as BusinessErrorCode, message: err.message };
    }
    return null;
  }
  if (isRecord(err) && err["name"] === "IdentityError") {
    const code: unknown = err["code"];
    const message: unknown = err["message"];
    if (typeof code === "string" && BUSINESS_CODES.has(code) && typeof message === "string") {
      return { code: code as BusinessErrorCode, message };
    }
  }
  return null;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Production grant issuance (PINNED contract). `ctx.identityStore` is
 * the D1-backed store from `buildProductionDeps`; the route itself is
 * mount-path agnostic (P-A owns the URL).
 */
export async function handleMcpGrant(
  req: Request,
  ctx: { identityStore: IdentityStore },
): Promise<Response> {
  if (req.method.toUpperCase() !== "POST") {
    return jsonError("method not allowed", 405);
  }
  let identity: GrantIdentityProducer;
  try {
    identity = await loadIdentity();
  } catch (err) {
    console.log("[mcp-grant] producer missing", err instanceof Error ? err.message : String(err));
    return jsonError("grant issuance is unavailable", 500);
  }

  const sessionToken = identity.parseSessionCookie(req.headers.get("cookie") ?? undefined);
  if (sessionToken === null) {
    return jsonError("mcp-grant needs a session", 401);
  }
  let resolved: ResolvedIdentity;
  try {
    resolved = await identity.resolveIdentity(ctx.identityStore, { session_token: sessionToken });
  } catch (err) {
    const failure = readIdentityFailure(identity, err);
    if (failure !== null) {
      return jsonError(failure.message, 401);
    }
    console.log("[mcp-grant] session resolve failed", err instanceof Error ? err.message : String(err));
    return jsonError("grant issuance failed", 500);
  }
  if (
    resolved.actor === null ||
    resolved.team === null ||
    resolved.membership === null ||
    resolved.membership.status !== "active"
  ) {
    return jsonError("mcp-grant needs an active team membership", 403);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("grant body must be JSON", 400);
  }
  const clientId: unknown = isRecord(body) ? body["client_id"] : undefined;
  if (typeof clientId !== "string" || clientId.trim() === "") {
    return jsonError("client_id is required", 400);
  }

  try {
    const issued = await identity.issueMcpGrant(ctx.identityStore, {
      user_id: resolved.actor.user_id,
      team_id: resolved.team.team_id,
      client_id: clientId,
    });
    // ONLY the four documented keys — never hashes, never internals.
    // The raw token is returned once and never stored or logged.
    return Response.json({
      token: issued.token,
      grant_id: issued.grant.grant_id,
      user_id: issued.grant.user_id,
      team_id: issued.grant.team_id,
    });
  } catch (err) {
    const failure = readIdentityFailure(identity, err);
    if (failure !== null) {
      return jsonError(failure.message, 400);
    }
    console.log("[mcp-grant] issuance failed", err instanceof Error ? err.message : String(err));
    return jsonError("grant issuance failed", 500);
  }
}
