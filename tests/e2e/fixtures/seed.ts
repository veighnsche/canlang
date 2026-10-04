/**
 * E2E seeding over REAL backends — TEST-ONLY fixtures, never production.
 *
 * - App rows go to REAL D1 through the L7 runner binding (`getD1Database`).
 *   The schema is the hand-built mirror in `./handbuilt/teamtasks.ts`
 *   (migrations arrive with L1 emission); the seed applies it verbatim
 *   and inserts the witness task from TeamTasks.can.
 * - Identity rows go through the REAL L6 memory `IdentityStore` inside the
 *   fixture worker via its TEST-ONLY `/__e2e/seed` endpoint: users, password
 *   hashes (real PBKDF2), memberships, sessions, and cookies are all minted
 *   by real L6 functions. The production fenced-D1 store (join J2) is NOT
 *   proven here and must not be claimed from these fixtures.
 *
 * No identity semantics are invented: this module only calls existing L6
 * exports (via the worker) and existing D1 APIs. If a journey needs a NEW
 * L6 API, that gap goes back to L6 — it is never filled in here.
 */
import type { LocalDev } from "@canlang/cloudflare";
import { TEAMTASKS_D1_SCHEMA } from "./handbuilt/teamtasks.js";

export interface SeedUserSpec {
  readonly email: string;
  readonly password: string;
  readonly owner?: boolean;
}

export interface SeededUser {
  readonly user_id: string;
  readonly email: string;
  readonly session_token: string;
  readonly csrf_token: string;
  /** Full `Set-Cookie` value from real L6 `buildSessionCookie` (insecure). */
  readonly cookie: string;
}

export interface SeedResult {
  readonly label: string;
  readonly team_id: string;
  readonly users: readonly SeededUser[];
}

/** Applies the hand-built schema verbatim; fails loud on D1 errors. */
export async function ensureTodoSchema(dev: LocalDev, binding: string): Promise<void> {
  const db = await dev.getD1Database(binding);
  await db.exec(TEAMTASKS_D1_SCHEMA);
}

/** Inserts the witness task mirroring the `fixture task` in TeamTasks.can. */
export async function seedFixtureTask(dev: LocalDev, binding: string): Promise<string> {
  const db = await dev.getD1Database(binding);
  const id = globalThis.crypto.randomUUID();
  await db
    .prepare("INSERT INTO todo (id, title, done, assignee, version, created) VALUES (?, ?, 0, NULL, 1, ?)")
    .bind(id, "Ship prototype", Date.now())
    .run();
  return id;
}

function assertSeedUser(value: unknown): SeededUser {
  if (typeof value !== "object" || value === null) throw new Error("e2e seed: bad user row");
  const row = value as Record<string, unknown>;
  for (const key of ["user_id", "email", "session_token", "csrf_token", "cookie"]) {
    if (typeof row[key] !== "string" || (row[key] as string).length === 0) {
      throw new Error(`e2e seed: user row missing ${key}`);
    }
  }
  return row as unknown as SeededUser;
}

/**
 * Seeds team + users through the fixture worker and returns session cookies
 * for Playwright contexts. `baseUrl` is the bridge URL of the SAME worker
 * instance the specs will drive (identity state is per-isolate).
 */
export async function seedTeamUsers(
  baseUrl: string,
  users: readonly SeedUserSpec[],
): Promise<SeedResult> {
  const response = await fetch(`${baseUrl}/__e2e/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ team: { timezone: "UTC" }, users }),
  });
  if (!response.ok) {
    throw new Error(`e2e seed: worker answered ${response.status}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body["team_id"] !== "string" || !Array.isArray(body["users"])) {
    throw new Error("e2e seed: malformed seed response");
  }
  return {
    label: typeof body["label"] === "string" ? body["label"] : "",
    team_id: body["team_id"],
    users: (body["users"] as unknown[]).map(assertSeedUser),
  };
}
