/**
 * Compiled-journey identity seeding — TEST-ONLY fixtures, never production.
 *
 * Members authenticate through the REAL L6 functions (`createTeam`,
 * `createUser`, `createMembership`, `createSession`, `resolveIdentity`)
 * over the REAL L6 memory `IdentityStore` from the built identity dist.
 * Scope (same as the T17a/T17b durable suites): the durable claim covers
 * the STATE store (real miniflare D1) — identity stays a memory double,
 * and the production fenced-D1 identity store is NOT proven here.
 *
 * Operation ids mirror the T17b durable harness (time-prefixed unique
 * hex in UUID shape); uniqueness per call is the load-bearing property.
 */
import { randomBytes } from "node:crypto";
import type { ResolvedIdentity } from "@canlang/contracts";
import type { createMemoryIdentityStore as MemoryStoreFn } from "@canlang/identity/testing";

const IDENTITY_DIST_BUILD_COMMAND = "bun run --filter @canlang/identity build";

type MemoryStore = ReturnType<typeof MemoryStoreFn>;

async function identityDist(): Promise<typeof import("@canlang/identity")> {
  try {
    return await import("@canlang/identity");
  } catch {
    throw new Error(
      `e2e seed: packages/identity/dist is not built; run \`${IDENTITY_DIST_BUILD_COMMAND}\` first`,
    );
  }
}

async function identityTesting(): Promise<typeof import("@canlang/identity/testing")> {
  try {
    return await import("@canlang/identity/testing");
  } catch {
    throw new Error(
      `e2e seed: packages/identity/dist is not built; run \`${IDENTITY_DIST_BUILD_COMMAND}\` first`,
    );
  }
}

export function freshOperationId(atMs: number): string {
  const timeHex = atMs.toString(16).padStart(12, "0");
  const rand = randomBytes(10).toString("hex");
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

export interface CompiledMember {
  readonly now: number;
  readonly store: MemoryStore;
  readonly teamId: string;
  readonly memberId: string;
  readonly memberToken: string;
  readonly identity: ResolvedIdentity;
}

/** Seed one team + one member and resolve the member identity. */
export async function seedCompiledMember(): Promise<CompiledMember> {
  const testing = await identityTesting();
  const identity = await identityDist();
  const now = Date.now();
  const clock = testing.createFrozenClock(now);
  const store = testing.createMemoryIdentityStore({ clock });
  const team = await store.createTeam({});
  const member = await store.createUser({
    email: "member@t21.test",
    password_hash: "x",
    email_verified: true,
  });
  await store.createMembership({
    team_id: team.team_id,
    user_id: member.user_id,
    is_owner: false,
    roles: [],
  });
  const memberToken = `member-token-${randomBytes(8).toString("hex")}`;
  await store.createSession({
    user_id: member.user_id,
    token_sha256: await identity.sha256HexText(memberToken),
    expires_at: new Date(now + 3600_000).toISOString(),
    last_team_id: team.team_id,
  });
  const resolved: ResolvedIdentity = await identity.resolveIdentity(
    store,
    { session_token: memberToken },
    { clock: { nowMs: () => now } },
  );
  return {
    now,
    store,
    teamId: team.team_id,
    memberId: member.user_id,
    memberToken,
    identity: resolved,
  };
}
