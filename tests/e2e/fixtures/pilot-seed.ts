/**
 * T37 pilot seeding — TEST-ONLY fixtures, never production.
 *
 * Two layers, both over REAL producers:
 *
 * - Identity: members authenticate through the REAL L6 functions over the
 *   REAL L6 memory `IdentityStore` (same durable-claim scope as the T21
 *   `compiled-seed`: STATE is the real miniflare D1 under test; identity
 *   stays a memory double).
 * - Staff bootstrap: the pilot's `staff()`/`can_work()` gates read
 *   `employee.Employee` rows whose `home` needs a `rent_catalog.Location`
 *   row, while producing either row through operation gates is circular
 *   (`Location.create` itself requires `can_work`). The seed therefore
 *   commits ONE fenced batch with the Location + Employee rows directly —
 *   exactly like the teamtasks specs seed D1 with raw SQL. Gates still
 *   evaluate genuinely on every journey operation; only the bootstrap rows
 *   bypass admission, and their bytes are pinned below.
 *
 * Member 0 holds the declared `todo.task_manager` role (Template/generate
 * journeys); member 1 is a plain member; the outsider has no membership
 * (denied-read journeys). `members` needs no grant: active membership is
 * the gate (proven by the T21 compiled seed with `roles: []`).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ArtifactTestModule,
  ModelName,
  OperationId,
  OperationName,
  RecordId,
  RecordVersion,
  ResolvedIdentity,
  StoragePort,
} from "@canlang/contracts";
import type { createMemoryIdentityStore as MemoryStoreFn } from "@canlang/identity/testing";

const IDENTITY_DIST_BUILD_COMMAND = "bun run --filter @canlang/identity build";

type MemoryStore = ReturnType<typeof MemoryStoreFn>;

async function identityDist(): Promise<typeof import("@canlang/identity")> {
  try {
    return await import("@canlang/identity");
  } catch {
    throw new Error(
      `pilot seed: packages/identity/dist is not built; run \`${IDENTITY_DIST_BUILD_COMMAND}\` first`,
    );
  }
}

async function identityTesting(): Promise<typeof import("@canlang/identity/testing")> {
  try {
    return await import("@canlang/identity/testing");
  } catch {
    throw new Error(
      `pilot seed: packages/identity/dist is not built; run \`${IDENTITY_DIST_BUILD_COMMAND}\` first`,
    );
  }
}

export interface PilotActor {
  readonly userId: string;
  readonly email: string;
  readonly token: string;
  readonly identity: ResolvedIdentity;
}

export interface PilotActors {
  readonly now: number;
  readonly store: MemoryStore;
  readonly teamId: string;
  /** Staff member holding `todo.task_manager` (+ `employee.hr`). */
  readonly manager: PilotActor;
  /** Plain staff member (no declared roles). */
  readonly member: PilotActor;
  /** Authenticated user with NO membership on the pilot team. */
  readonly outsider: PilotActor;
}

async function createActor(
  testing: Awaited<ReturnType<typeof identityTesting>>,
  identity: Awaited<ReturnType<typeof identityDist>>,
  store: MemoryStore,
  teamId: string,
  now: number,
  email: string,
  roleNames: readonly string[],
  membership: boolean,
): Promise<PilotActor> {
  const user = await store.createUser({
    email,
    password_hash: "x",
    email_verified: true,
  });
  if (membership) {
    await store.createMembership({
      team_id: teamId,
      user_id: user.user_id,
      is_owner: false,
      roles: roleNames.map((role) => ({
        role,
        granted_at: new Date(now).toISOString(),
        granted_by: user.user_id,
      })),
    });
  }
  const token = `pilot-token-${randomBytes(8).toString("hex")}`;
  await store.createSession({
    user_id: user.user_id,
    token_sha256: await identity.sha256HexText(token),
    expires_at: new Date(now + 3600_000).toISOString(),
    last_team_id: teamId,
  });
  const resolved: ResolvedIdentity = await identity.resolveIdentity(
    store,
    { session_token: token },
    { clock: { nowMs: () => now } },
  );
  return { userId: user.user_id, email, token, identity: resolved };
}

/** Seed one team + manager/member/outsider and resolve all identities. */
export async function seedPilotActors(): Promise<PilotActors> {
  const testing = await identityTesting();
  const identity = await identityDist();
  const now = Date.now();
  const clock = testing.createFrozenClock(now);
  const store = testing.createMemoryIdentityStore({ clock });
  const team = await store.createTeam({});
  // Role grants are canonical (`{module}.{Role}`). `members` is granted
  // EXPLICITLY: scenario `by=members` lowers to `hasRole(c,"members")`
  // (probe-proven: without the grant every scenario rejects `forbidden`;
  // only the CRUD path treats active membership as implicit).
  const manager = await createActor(testing, identity, store, team.team_id, now, "ada@pilot.test", ["members", "todo.task_manager", "employee.hr"], true);
  const member = await createActor(testing, identity, store, team.team_id, now, "bob@pilot.test", ["members"], true);
  const outsider = await createActor(
    testing,
    identity,
    store,
    team.team_id,
    now,
    "mallory@elsewhere.test",
    [],
    false,
  );
  return { now, store, teamId: team.team_id, manager, member, outsider };
}

export interface PilotStaff {
  readonly locationId: string;
}

/**
 * Commit the staff bootstrap rows (one Location + one active Employee per
 * member) as ONE fenced batch. Values are tagged CanValues exactly as the
 * engine stores them (`{kind:'user',id}`, `{kind:'ref',model,id}`,
 * `{kind:'date',...}`); timezone/currency stay plain strings (no value
 * tag exists for them).
 */
export async function seedPilotStaff(
  store: StoragePort,
  actors: PilotActors,
  operationPrefix: string,
): Promise<PilotStaff> {
  const at = actors.now;
  const version = 1 as RecordVersion;
  const locationId = `loc-pilot-${operationPrefix}` as RecordId;
  const locationRef = { kind: "ref", model: "rent_catalog.Location", id: locationId };
  const writes = [
    {
      kind: "insert" as const,
      model: "rent_catalog.Location" as ModelName,
      row: {
        id: locationId,
        version,
        created: at,
        updated: at,
        createdBy: "pilot-seed",
        updatedBy: "pilot-seed",
        archivedAt: null,
        data: {
          name: "Pilot hall",
          address: "1 Pilot Road",
          timezone: "Europe/Brussels",
          currency: "EUR",
          hours: "09:00-18:00",
          arrival: "Report to reception",
          active: true,
        },
      },
    },
    ...[actors.manager, actors.member].map((actor, index) => ({
      kind: "insert" as const,
      model: "employee.Employee" as ModelName,
      row: {
        id: `emp-pilot-${operationPrefix}-${index}` as RecordId,
        version,
        created: at,
        updated: at,
        createdBy: "pilot-seed",
        updatedBy: "pilot-seed",
        archivedAt: null,
        data: {
          user: { kind: "user", id: actor.userId },
          home: locationRef,
          locations: [locationRef],
          operator_wide: false,
          active: true,
          start: { kind: "date", year: 2026, month: 10, day: 1 },
          role: "operator",
          skills: [],
        },
      },
    })),
  ];
  const history = writes.map((write, index) => ({
    model: write.model,
    recordId: write.row.id,
    version,
    operation: `${write.model}.create` as OperationName,
    operationId: `seed-${operationPrefix}-${index}` as OperationId,
    actor: "pilot-seed",
    at,
    change: "create" as const,
    before: null,
    after: write.row.data,
  }));
  await store.commit({
    expectedRevision: await store.readRevision(),
    writes,
    history,
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
  });
  return { locationId };
}

/**
 * Stage one emitted BDD suite module (`artifact.tests[]`) onto disk for a
 * plain-Node dynamic import. Suite modules are self-contained (the BDD
 * emitter emits no JS imports), so no import rewriting applies; a module
 * that does import fails loud at import with the exact specifier.
 */
export function stageSuiteModule(workDir: string, suite: ArtifactTestModule): string {
  const outPath = join(workDir, suite.module.path);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, suite.module.js, "utf8");
  return pathToFileURL(outPath).href;
}
