/**
 * P-C production grant route tests (`src/runtime/grant-route.ts`).
 *
 * Failing-first: written before the module existed. Proves the pinned
 * `handleMcpGrant` contract: session-cookie authed like the fixture
 * `POST /__e2e/mcp-grant` (same request/response vocabulary) but with
 * NO test-only marker — this is the production issuance path.
 *
 * Success is 200 `{token, grant_id, user_id, team_id}` minted via real
 * `issueMcpGrant`; the token resolves through real `resolveIdentity`
 * with the `mcp_grant` binding. Failures are safe + loud: 405 on
 * non-POST, 401 on missing/invalid session, 403 without an active
 * team membership, 400 on malformed body/client_id. The response
 * carries ONLY the four documented keys (no hashes, no internals).
 */
import { describe, expect, it } from "vitest";
import { buildSessionCookie, resolveIdentity, sha256HexText } from "@canlang/identity";
import { createMemoryIdentityStore } from "@canlang/identity/testing";
import { handleMcpGrant } from "../src/runtime/grant-route.js";

async function seedTeam() {
  const store = createMemoryIdentityStore();
  const user = await store.createUser({
    email: "grant@test.example",
    password_hash: "test-hash-opaque",
    email_verified: true,
  });
  const team = await store.createTeam({});
  await store.createMembership({
    team_id: team.team_id,
    user_id: user.user_id,
    is_owner: true,
    roles: [],
  });
  return { store, user, team };
}

async function seedSession(
  store: Awaited<ReturnType<typeof seedTeam>>["store"],
  userId: string,
  teamId: string | null,
): Promise<{ token: string; cookie: string }> {
  const token = `grant-route-session-${Math.random().toString(36).slice(2)}`;
  await store.createSession({
    user_id: userId,
    token_sha256: await sha256HexText(token),
    expires_at: "2030-01-01T00:00:00.000Z",
    last_team_id: teamId,
  });
  const cookie = buildSessionCookie(token, { maxAgeSeconds: 3600, secure: false });
  return { token, cookie };
}

function grantRequest(cookie: string | null, body: unknown): Request {
  return new Request("https://test.invalid/mcp/grant", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie === null ? {} : { cookie }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleMcpGrant", () => {
  it("405s non-POST methods", async () => {
    const { store } = await seedTeam();
    const res = await handleMcpGrant(
      new Request("https://test.invalid/mcp/grant", { method: "GET" }),
      { identityStore: store },
    );
    expect(res.status).toBe(405);
  });

  it("401s without a session cookie or with an unknown session", async () => {
    const { store } = await seedTeam();
    const naked = await handleMcpGrant(grantRequest(null, { client_id: "c" }), {
      identityStore: store,
    });
    expect(naked.status).toBe(401);

    const bogusCookie = buildSessionCookie("bogus-not-a-session", {
      maxAgeSeconds: 3600,
      secure: false,
    });
    const bogus = await handleMcpGrant(grantRequest(bogusCookie, { client_id: "c" }), {
      identityStore: store,
    });
    expect(bogus.status).toBe(401);
    expect(((await bogus.json()) as { error: string }).error).toBe(
      "Session expired or revoked.",
    );
  });

  it("403s a session without an active team membership", async () => {
    const store = createMemoryIdentityStore();
    const user = await store.createUser({
      email: "lonely@test.example",
      password_hash: "test-hash-opaque",
      email_verified: true,
    });
    const { cookie } = await seedSession(store, user.user_id, null);
    const res = await handleMcpGrant(grantRequest(cookie, { client_id: "c" }), {
      identityStore: store,
    });
    expect(res.status).toBe(403);
  });

  it("400s malformed bodies and bad client_id values", async () => {
    const { store, user, team } = await seedTeam();
    const { cookie } = await seedSession(store, user.user_id, team.team_id);
    const ctx = { identityStore: store };

    const notJson = await handleMcpGrant(grantRequest(cookie, "{oops"), ctx);
    expect(notJson.status).toBe(400);

    for (const body of [{}, { client_id: "" }, { client_id: "   " }, { client_id: 42 }]) {
      const res = await handleMcpGrant(grantRequest(cookie, body), ctx);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    const tooLong = await handleMcpGrant(grantRequest(cookie, { client_id: "x".repeat(300) }), ctx);
    expect(tooLong.status).toBe(400);
  });

  it("mints a grant bound to the session team; token resolves as mcp_grant", async () => {
    const { store, user, team } = await seedTeam();
    const { cookie } = await seedSession(store, user.user_id, team.team_id);
    const res = await handleMcpGrant(grantRequest(cookie, { client_id: "prod-mcp-host" }), {
      identityStore: store,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["grant_id", "team_id", "token", "user_id"]);
    expect(typeof body["token"]).toBe("string");
    expect((body["token"] as string).length).toBeGreaterThan(0);
    expect(body["user_id"]).toBe(user.user_id);
    expect(body["team_id"]).toBe(team.team_id);
    expect(JSON.stringify(body)).not.toContain("sha256");

    const resolved = await resolveIdentity(store, { mcp_grant_token: body["token"] as string });
    expect(resolved.binding.kind).toBe("mcp_grant");
    expect(resolved.actor?.user_id).toBe(user.user_id);
    expect(resolved.team?.team_id).toBe(team.team_id);
    expect(resolved.membership?.status).toBe("active");
  });
});
