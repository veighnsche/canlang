/**
 * MCP grant fixture — TEST-ONLY, never production.
 *
 * Mints a real MCP grant Bearer [REDACTED] the e2e user through the fixture
 * worker's TEST-ONLY `POST /__e2e/mcp-grant` endpoint (same pattern as
 * `seedTeamUsers` in `./seed.ts`: session cookie in, worker-minted
 * credential out). The endpoint verifies the caller's session with real L6
 * `resolveIdentity` and mints with real L6 `issueMcpGrant`
 * (`packages/identity/src/authentication/grants.ts`); this module only
 * transports the request/response and never invents identity semantics.
 *
 * Contract (the endpoint lands with the P1/P2 fixture join):
 * - request: `POST /__e2e/mcp-grant`, `cookie: can_session=<session>`,
 *   JSON body `{client_id: string}`.
 * - success: HTTP 200 `{token, grant_id, user_id, team_id}`. `token` is the
 *   raw Bearer [REDACTED] shown once — never stored or logged.
 * - failure: non-200; this module throws naming the status (today: 404, the
 *   endpoint does not exist yet — the expected failing-first gap).
 */
export interface McpGrantSeed {
  /** Raw grant Bearer [REDACTED] test memory only; never logged. */
  readonly token: string;
  readonly grant_id: string;
  readonly user_id: string;
  readonly team_id: string;
}

/**
 * Mint a grant for the holder of `sessionToken`. `baseUrl` is the bridge
 * URL of the SAME worker instance the spec drives (identity state is
 * per-isolate).
 */
export async function mintMcpGrant(
  baseUrl: string,
  sessionToken: string,
  clientId: string,
): Promise<McpGrantSeed> {
  const response = await fetch(`${baseUrl}/__e2e/mcp-grant`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `can_session=${sessionToken}`,
    },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!response.ok) {
    throw new Error(
      `e2e mcp-grant: worker answered ${response.status} ` +
        `(needs the TEST-ONLY POST /__e2e/mcp-grant endpoint, which mints via real L6 issueMcpGrant)`,
    );
  }
  const body = (await response.json()) as Record<string, unknown>;
  for (const key of ["token", "grant_id", "user_id", "team_id"]) {
    if (typeof body[key] !== "string" || (body[key] as string).length === 0) {
      throw new Error(`e2e mcp-grant: malformed grant response (missing ${key})`);
    }
  }
  return body as unknown as McpGrantSeed;
}
