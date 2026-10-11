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
 * team membership or valid session CSRF, 400 on unsupported media or
 * malformed body/client_id, 429 on oversized streaming body. The response
 * carries ONLY the four documented keys (no hashes, no internals).
 */
import { describe, expect, it, vi } from "vitest";
import { buildSessionCookie, deriveCsrfToken, resolveIdentity, sha256HexText } from "@canlang/identity";
import { JSON_BODY_MAX_BYTES } from '@canlang/interfaces';
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
): Promise<{ token: string; cookie: string; csrf: string }> {
  const token = `grant-route-session-${Math.random().toString(36).slice(2)}`;
  await store.createSession({
    user_id: userId,
    token_sha256: await sha256HexText(token),
    expires_at: "2030-01-01T00:00:00.000Z",
    last_team_id: teamId,
  });
  const cookie = buildSessionCookie(token, { maxAgeSeconds: 3600, secure: false });
  return { token, cookie, csrf: await deriveCsrfToken(token) };
}

function grantRequest(cookie: string | null, body: unknown, csrf?: string): Request {
  return new Request("https://test.invalid/mcp/grant", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie === null ? {} : { cookie }),
      ...(csrf === undefined ? {} : { 'x-csrf-token': csrf }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleMcpGrant", () => {
  it('checks explicit trusted Origin before session lookup or body reads and retains session CSRF without Origin', async () => {
    const { store, user, team } = await seedTeam();
    const { cookie, csrf } = await seedSession(store, user.user_id, team.team_id);
    const authOrigin = 'https://auth.example';
    let lookups = 0; let issued = 0;
    const lookup = store.findSessionByTokenHash.bind(store);
    const mint = store.createMcpGrant.bind(store);
    store.findSessionByTokenHash = async hash => { lookups++; return lookup(hash); };
    store.createMcpGrant = async input => { issued++; return mint(input); };
    const ctx = { identityStore: store, authOrigin };
    for (const origin of ['https://foreign.example', 'null', 'not a URL',
      `${authOrigin}/path`, 'https://user:password@auth.example', '']) {
      const request = grantRequest(cookie, { client_id: 'origin-client' }, csrf);
      request.headers.set('origin', origin);
      const reads = vi.spyOn(request.body!, 'getReader');
      try {
        const response = await handleMcpGrant(request, ctx);
        expect(response.status, origin).toBe(403);
        expect(await response.json()).toEqual({ error: 'Invalid authentication origin.' });
        expect(lookups).toBe(0); expect(issued).toBe(0);
        expect(reads).not.toHaveBeenCalled();
      } finally { reads.mockRestore(); }
    }
    const missingCsrf = await handleMcpGrant(grantRequest(cookie, { client_id: 'origin-client' }), ctx);
    expect(missingCsrf.status).toBe(403); expect(issued).toBe(0);
    for (const origin of [undefined, authOrigin]) {
      const request = grantRequest(cookie, { client_id: 'origin-client' }, csrf);
      if (origin !== undefined) request.headers.set('origin', origin);
      const response = await handleMcpGrant(request, ctx);
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['grant_id', 'team_id', 'token', 'user_id']);
      const resolved = await resolveIdentity(store, { mcp_grant_token: body['token'] as string });
      expect(resolved.binding.kind).toBe('mcp_grant');
      expect(resolved.actor?.user_id).toBe(user.user_id);
      expect(resolved.team?.team_id).toBe(team.team_id);
    }
    expect(issued).toBe(2);
  });

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
    const { cookie, csrf } = await seedSession(store, user.user_id, team.team_id);
    const ctx = { identityStore: store };

    const notJson = await handleMcpGrant(grantRequest(cookie, "{oops", csrf), ctx);
    expect(notJson.status).toBe(400);

    for (const body of [{}, { client_id: "" }, { client_id: "   " }, { client_id: 42 }]) {
      const res = await handleMcpGrant(grantRequest(cookie, body, csrf), ctx);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    const tooLong = await handleMcpGrant(grantRequest(cookie, { client_id: "x".repeat(300) }, csrf), ctx);
    expect(tooLong.status).toBe(400);
  });

  it("mints a grant bound to the session team; token resolves as mcp_grant", async () => {
    const { store, user, team } = await seedTeam();
    const { cookie, csrf } = await seedSession(store, user.user_id, team.team_id);
    const res = await handleMcpGrant(grantRequest(cookie, { client_id: "prod-mcp-host" }, csrf), {
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

  it('caps streaming JSON and requires current session CSRF before any grant issuance', async () => {
    const { store, user, team } = await seedTeam();
    const { cookie, csrf } = await seedSession(store, user.user_id, team.team_id);
    const foreign = await seedSession(store, user.user_id, team.team_id);
    let issued = 0;
    const original = store.createMcpGrant.bind(store);
    store.createMcpGrant = async input => { issued++; return original(input); };
    const ctx = { identityStore: store };
    for (const [body, header] of [
      [{ client_id: 'c' }, undefined], [{ client_id: 'c' }, 'wrong'],
      [{ client_id: 'c' }, foreign.csrf], [{ client_id: 'c', _csrf: csrf }, 'wrong'],
      [{ client_id: 'c', _csrf: csrf }, ''], [{ client_id: 'c', _csrf: 1 }, undefined],
      [{ client_id: '' }, undefined],
    ] as const) {
      const response = await handleMcpGrant(grantRequest(cookie, body, header), ctx);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Invalid or missing CSRF token.' });
      expect(issued).toBe(0);
    }
    for (const mediaType of ['', 'text/plain', 'application/x-www-form-urlencoded']) {
      const request = grantRequest(cookie, { client_id: 'c' }, csrf);
      if (mediaType === '') request.headers.delete('content-type');
      else request.headers.set('content-type', mediaType);
      expect((await handleMcpGrant(request, ctx)).status).toBe(400);
      expect(issued).toBe(0);
    }
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(JSON_BODY_MAX_BYTES + 1)); },
      cancel() { cancelled = true; },
    });
    const oversized = new Request('https://test.invalid/mcp/grants', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body, duplex: 'half',
    } as RequestInit);
    expect((await handleMcpGrant(oversized, ctx)).status).toBe(429);
    expect(cancelled).toBe(true); expect(issued).toBe(0);
    const malformed = await handleMcpGrant(grantRequest(cookie, '{oops', csrf), ctx);
    expect(malformed.status).toBe(400); expect(issued).toBe(0);
    // Exact cap remains admitted; field CSRF and normalized JSON media type
    // are real supported transport inputs, not alternate authentication.
    const base = JSON.stringify({ client_id: 'c', _csrf: csrf, padding: '' });
    const exact = grantRequest(cookie, { client_id: 'c', _csrf: csrf,
      padding: 'x'.repeat(JSON_BODY_MAX_BYTES - new TextEncoder().encode(base).byteLength) });
    exact.headers.set('content-type', 'Application/JSON; charset=utf-8');
    expect((await handleMcpGrant(exact, ctx)).status).toBe(200); expect(issued).toBe(1);
    const preferred = await handleMcpGrant(grantRequest(cookie, { client_id: 'c', _csrf: 'wrong' }, csrf), ctx);
    expect(preferred.status).toBe(200); expect(issued).toBe(2);
  });
});
