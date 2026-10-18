/**
 * P-C grant-route evaluation/getter/error-boundary pinning
 * (`src/runtime/grant-route.ts` `handleMcpGrant` extraction).
 *
 * The happy-path suite does not cover these: the store getter must be
 * read only after a valid session cookie and inside the resolve/issuance
 * tries, and actor/team/membership evaluation must stay OUTSIDE the
 * resolve try so getter throws propagate instead of remapping.
 */
import { describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  parseSessionCookie: vi.fn(),
  resolveIdentity: vi.fn(),
  verifyCsrfToken: vi.fn(),
  issueMcpGrant: vi.fn(),
}));

vi.mock("@canlang/identity", () => ({
  parseSessionCookie: stubs.parseSessionCookie,
  resolveIdentity: stubs.resolveIdentity,
  verifyCsrfToken: stubs.verifyCsrfToken,
  issueMcpGrant: stubs.issueMcpGrant,
  IdentityError: class IdentityError extends Error {},
}));

import { handleMcpGrant } from "../src/runtime/grant-route.js";
import type { IdentityStore } from "../src/runtime/env-assembly.js";

const mockStore = {} as IdentityStore;

function post(body: unknown, cookie: string | null): Request {
  return new Request("https://test.invalid/mcp/grant", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie === null ? {} : { cookie }),
      "x-csrf-token": "csrf",
    },
    body: JSON.stringify(body),
  });
}

function activeResolved() {
  return {
    actor: { user_id: "u" },
    team: { team_id: "t" },
    membership: { status: "active" },
  };
}

describe("handleMcpGrant evaluation boundaries", () => {
  it("401s on a missing cookie without reading ctx.identityStore", async () => {
    stubs.parseSessionCookie.mockReturnValue(null);
    let storeReads = 0;
    const ctx: { identityStore: IdentityStore } = {
      get identityStore(): IdentityStore {
        storeReads++;
        throw new Error("store must not be read");
      },
    };
    const response = await handleMcpGrant(post({ client_id: "c" }, null), ctx);
    expect(response.status).toBe(401);
    expect(storeReads).toBe(0);
    expect(stubs.resolveIdentity).not.toHaveBeenCalled();
  });

  it("500s when the store getter throws inside resolveIdentity, after cookie validation", async () => {
    stubs.parseSessionCookie.mockReturnValue("tok");
    stubs.resolveIdentity.mockImplementation(() => {
      throw new Error("store down");
    });
    const order: string[] = [];
    const ctx: { identityStore: IdentityStore } = {
      get identityStore(): IdentityStore {
        order.push("store");
        throw new Error("store down");
      },
    };
    const response = await handleMcpGrant(post({ client_id: "c" }, "can_session=tok"), ctx);
    expect(response.status).toBe(500);
    expect(order).toEqual(["store"]);
  });

  it("lets membership getter throws propagate instead of remapping", async () => {
    stubs.parseSessionCookie.mockReturnValue("tok");
    stubs.resolveIdentity.mockResolvedValue({
      actor: { user_id: "u" },
      team: { team_id: "t" },
      get membership(): unknown {
        throw new Error("membership getter boom");
      },
    });
    stubs.verifyCsrfToken.mockResolvedValue(true);
    await expect(
      handleMcpGrant(post({ client_id: "c" }, "can_session=tok"), { identityStore: mockStore }),
    ).rejects.toThrow("membership getter boom");
  });

  it("still 403s inactive membership and 200s active issuance", async () => {
    stubs.parseSessionCookie.mockReturnValue("tok");
    stubs.resolveIdentity.mockResolvedValue({
      ...activeResolved(),
      membership: { status: "revoked" },
    });
    stubs.verifyCsrfToken.mockResolvedValue(true);
    const forbidden = await handleMcpGrant(post({ client_id: "c" }, "can_session=tok"), {
      identityStore: mockStore,
    });
    expect(forbidden.status).toBe(403);

    stubs.resolveIdentity.mockResolvedValue(activeResolved());
    stubs.issueMcpGrant.mockResolvedValue({
      token: "tok-out",
      grant: { grant_id: "g", user_id: "u", team_id: "t" },
    });
    const ok = await handleMcpGrant(post({ client_id: "c" }, "can_session=tok"), {
      identityStore: mockStore,
    });
    expect(ok.status).toBe(200);
    expect(Object.keys(await ok.json()).sort()).toEqual(["grant_id", "team_id", "token", "user_id"]);
  });
});
