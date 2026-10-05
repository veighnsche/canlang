/**
 * B2 role/session revocation spec (L7 directory; this ONE file is the
 * B2 revocation case body per the join contract in
 * `tests/integration/README.md`).
 *
 * Drives the REAL L6 revocation entry points (`setMemberRole`,
 * `removeMember`, `revokeSessionByToken`, `signOutEverywhere`) over
 * L6's own memory store double and observes grant/revoke, the
 * last-owner guard, the removal cascade (row retained, team grants
 * revoked, other-team grants untouched), session revocation
 * idempotency (original `revoked_at` preserved) and sign-out-everywhere
 * isolation. Every evidence row is labelled `local` in its detail
 * string; every real row names the memory-store double plus the
 * unlanded production binding (J2 fenced D1). Two rows are permanently
 * `unsupported` and name the exact unmet contracts for
 * revocation-observed-through-admission and the served legs.
 *
 * Producer loading follows the lane02 join precedent exactly: the L6
 * sources load through NON-LITERAL dynamic specifiers, so this file
 * typechecks with the producers absent and fails loud (every row
 * `unsupported` with the exact absent detail below) when any load
 * fails at runtime.
 */
import { describe, expect, it } from "vitest";
import { createReport, diffReportValues } from "@canlang/testkit";
import type {
  ObservationMismatch,
  ReportValue,
  ResolvedCaller,
  TableCaseResult,
  TableRowResult,
} from "@canlang/contracts";
import {
  B2_APPROVER_ROLE,
  b2BearerToken,
  readB2IdentityError,
  readB2MemberRoles,
  readB2RevokedAt,
} from "../../packages/testkit/src/fixtures/b2-revocation.js";

/** Exact absent-producer detail every producer-dependent row carries. */
const ABSENT_SENTENCE =
  "L6 identity producer absent; run root `bun run test` from a checkout with packages/identity/src/{testing,authentication/revocation,teams/roles,teams/membership,sessions/tokens}.ts";
const ABSENT_DETAIL = `local | ${ABSENT_SENTENCE}`;

/** Honest-store label every real row carries. */
const STORE_DOUBLE = "L6 memory store double (production J2 fenced-D1 binding unlanded)";

const LOCAL_CALLER: ResolvedCaller = {
  account: "local-b2-revocation",
  team: null,
  roles: [],
  authenticated: false,
};

const CLOCK_START = 1_758_000_000_000;
const EXPIRES_AT = new Date(CLOCK_START + 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// Producer surface (dynamic TS-source imports; any failure routes to
// unsupported). Structural mirrors only — @canlang/identity has no
// build, so static imports (even type-only) would drag L6 sources into
// the root check; non-literal specifiers keep tsc blind (lane02).
// ---------------------------------------------------------------------------

const TESTING_SPECIFIER = "../../packages/identity/src/testing.ts";
const REVOCATION_SPECIFIER = "../../packages/identity/src/authentication/revocation.ts";
const ROLES_SPECIFIER = "../../packages/identity/src/teams/roles.ts";
const MEMBERSHIP_SPECIFIER = "../../packages/identity/src/teams/membership.ts";
const TOKENS_SPECIFIER = "../../packages/identity/src/sessions/tokens.ts";

interface IdentityStoreView {
  createUser(input: { email: string; password_hash: string; email_verified: boolean }): Promise<unknown>;
  createTeam(input: { timezone?: string }): Promise<unknown>;
  createMembership(input: {
    team_id: string;
    user_id: string;
    is_owner: boolean;
    roles: readonly unknown[];
  }): Promise<unknown>;
  findMembership(team_id: string, user_id: string): Promise<unknown>;
  createSession(input: {
    user_id: string;
    token_sha256: string;
    expires_at: string;
    last_team_id: string | null;
  }): Promise<unknown>;
  findSessionByTokenHash(token_sha256: string): Promise<unknown>;
  createMcpGrant(input: {
    user_id: string;
    team_id: string | null;
    client_id: string;
    token_sha256: string;
    expires_at: string;
  }): Promise<unknown>;
  findMcpGrantByTokenHash(token_sha256: string): Promise<unknown>;
}

interface FrozenClockView {
  advance(ms: number): void;
}

interface RevocationProducer {
  createStore(clock: unknown): IdentityStoreView;
  createClock(startMs: number): FrozenClockView;
  revokeSessionByToken(store: unknown, input: { token: string }): Promise<unknown>;
  signOutEverywhere(store: unknown, input: { user_id: string }): Promise<unknown>;
  setMemberRole(
    store: unknown,
    input: { team_id: string; member_user_id: string; role: string },
    opts: { granted_by: string },
  ): Promise<unknown>;
  removeMember(
    store: unknown,
    input: { team_id: string; member_user_id: string },
    opts: { removed_by: string },
  ): Promise<unknown>;
  sha256HexText(text: string): Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickFn(mod: unknown, name: string, file: string): (...args: any[]) => any {
  if (!isRecord(mod) || typeof mod[name] !== "function") {
    throw new Error(`identity ${file} loaded but exports no ${name} (stale source?)`);
  }
  return mod[name] as (...args: any[]) => any;
}

async function loadProducer(): Promise<RevocationProducer | null> {
  let testing: unknown;
  let revocation: unknown;
  let roles: unknown;
  let membership: unknown;
  let tokens: unknown;
  try {
    [testing, revocation, roles, membership, tokens] = await Promise.all([
      import(TESTING_SPECIFIER),
      import(REVOCATION_SPECIFIER),
      import(ROLES_SPECIFIER),
      import(MEMBERSHIP_SPECIFIER),
      import(TOKENS_SPECIFIER),
    ]);
  } catch {
    return null;
  }
  const createMemoryIdentityStore = pickFn(testing, "createMemoryIdentityStore", "testing.ts");
  const createFrozenClock = pickFn(testing, "createFrozenClock", "testing.ts");
  const revokeSessionByToken = pickFn(revocation, "revokeSessionByToken", "revocation.ts");
  const signOutEverywhere = pickFn(revocation, "signOutEverywhere", "revocation.ts");
  const setMemberRole = pickFn(roles, "setMemberRole", "roles.ts");
  const removeMember = pickFn(membership, "removeMember", "membership.ts");
  const sha256HexText = pickFn(tokens, "sha256HexText", "tokens.ts");
  return {
    createStore: (clock: unknown): IdentityStoreView =>
      createMemoryIdentityStore({ clock }) as unknown as IdentityStoreView,
    createClock: (startMs: number): FrozenClockView =>
      createFrozenClock(startMs) as unknown as FrozenClockView,
    revokeSessionByToken: async (store: unknown, input: { token: string }): Promise<unknown> =>
      await (revokeSessionByToken as (store: unknown, input: { token: string }) => Promise<unknown>)(store, input),
    signOutEverywhere: async (store: unknown, input: { user_id: string }): Promise<unknown> =>
      await (signOutEverywhere as (store: unknown, input: { user_id: string }) => Promise<unknown>)(store, input),
    setMemberRole: async (
      store: unknown,
      input: { team_id: string; member_user_id: string; role: string },
      opts: { granted_by: string },
    ): Promise<unknown> =>
      await (
        setMemberRole as (
          store: unknown,
          input: { team_id: string; member_user_id: string; role: string },
          opts: { granted_by: string },
        ) => Promise<unknown>
      )(store, input, opts),
    removeMember: async (
      store: unknown,
      input: { team_id: string; member_user_id: string },
      opts: { removed_by: string },
    ): Promise<unknown> =>
      await (
        removeMember as (
          store: unknown,
          input: { team_id: string; member_user_id: string },
          opts: { removed_by: string },
        ) => Promise<unknown>
      )(store, input, opts),
    sha256HexText: async (text: string): Promise<string> =>
      (await (sha256HexText as (text: string) => Promise<string>)(text)) as string,
  };
}

function readId(row: unknown, field: string, what: string): string {
  if (!isRecord(row) || typeof row[field] !== "string" || (row[field] as string) === "") {
    throw new Error(`${what}: row carries no ${field}`);
  }
  return row[field] as string;
}

function readField(row: unknown, field: string, what: string): unknown {
  if (!isRecord(row) || !(field in row)) {
    throw new Error(`${what}: row carries no ${field}`);
  }
  return row[field];
}

// ---------------------------------------------------------------------------
// Row helpers (same shape as the lane02 join).
// ---------------------------------------------------------------------------

function passedRow(rowIndex: number, label: string, mismatches: ObservationMismatch[]): TableRowResult {
  if (mismatches.length > 0) {
    return {
      rowIndex,
      caller: LOCAL_CALLER,
      outcome: "failed",
      mismatches,
      detail: `local | ${label} (${STORE_DOUBLE}): ${mismatches.length} mismatch(es)`,
    };
  }
  return { rowIndex, caller: LOCAL_CALLER, outcome: "passed", detail: `local | ${label} (${STORE_DOUBLE})` };
}

function failedRow(rowIndex: number, label: string, problem: string): TableRowResult {
  return { rowIndex, caller: LOCAL_CALLER, outcome: "failed", detail: `local | ${label}: ${problem}` };
}

function unsupportedRow(rowIndex: number, detail: string): TableRowResult {
  return { rowIndex, caller: LOCAL_CALLER, outcome: "unsupported", detail };
}

function blockedRows(): TableRowResult[] {
  return [
    unsupportedRow(
      0,
      "local | BLOCKED (L3 admission + J2 identity binding): revoked role denies subsequent invocation — admit/invoke stay unexported and production identity binds no fenced D1",
    ),
    unsupportedRow(
      1,
      "local | BLOCKED (L1 emission + worker assembly + F2 context): revoked role observed by the browser and MCP legs of a served app",
    ),
  ];
}

// ---------------------------------------------------------------------------
// The join case.
// ---------------------------------------------------------------------------

describe("b2 role and session revocation", () => {
  it("observes revocation entry points over the L6 store, or reports unsupported", async () => {
    const producer = await loadProducer();
    const builder = createReport({ digest: "b2-revocation", sourceRevision: "b2-revocation" });

    if (producer === null) {
      const journeyRows: TableRowResult[] = [0, 1, 2, 3, 4].map((rowIndex) =>
        unsupportedRow(rowIndex, ABSENT_DETAIL),
      );
      builder.addCase({ kind: "table", operation: "b2.revocation.journey", rows: journeyRows });
      builder.addCase({ kind: "table", operation: "b2.revocation.blocked", rows: blockedRows() });
      const report = builder.build();
      expect(report.summary.total).toBe(journeyRows.length + 2);
      expect(report.summary.passed).toBe(0);
      expect(report.summary.failed).toBe(0);
      expect(report.summary.setupFailed).toBe(0);
      expect(report.summary.unsupported).toBe(report.summary.total);
      for (const row of journeyRows) {
        expect(row.outcome).toBe("unsupported");
        expect(row.detail).toContain(ABSENT_SENTENCE);
        expect(row.detail).toContain("local");
      }
      return;
    }

    const clock = producer.createClock(CLOCK_START);
    const store = producer.createStore(clock);
    const owner = readId(
      await store.createUser({ email: "owner@example.test", password_hash: "hash-owner", email_verified: true }),
      "user_id",
      "seed.owner",
    );
    const member = readId(
      await store.createUser({ email: "member@example.test", password_hash: "hash-member", email_verified: true }),
      "user_id",
      "seed.member",
    );
    const team = readId(await store.createTeam({}), "team_id", "seed.team");
    const otherTeam = readId(await store.createTeam({}), "team_id", "seed.other-team");
    await store.createMembership({ team_id: team, user_id: owner, is_owner: true, roles: [] });
    await store.createMembership({ team_id: team, user_id: member, is_owner: false, roles: [] });
    await store.createMembership({ team_id: otherTeam, user_id: member, is_owner: false, roles: [] });
    const rows: TableRowResult[] = [];

    // Row 0: grant then revoke a declared role — membership stays active, history untouched.
    try {
      const before = await store.findMembership(team, member);
      const createdAt = readField(before, "created_at", "row-0.before");
      const granted = await producer.setMemberRole(
        store,
        { team_id: team, member_user_id: member, role: B2_APPROVER_ROLE },
        { granted_by: owner },
      );
      const grantedRoles = readB2MemberRoles(granted, "row-0.granted");
      const revoked = await producer.setMemberRole(
        store,
        { team_id: team, member_user_id: member, role: `-${B2_APPROVER_ROLE}` },
        { granted_by: owner },
      );
      const revokedRoles = readB2MemberRoles(revoked, "row-0.revoked");
      const mismatches: ObservationMismatch[] = [
        ...diffReportValues("row-0.granted", true as ReportValue, grantedRoles.includes(B2_APPROVER_ROLE) as ReportValue),
        ...diffReportValues("row-0.revoked", false as ReportValue, revokedRoles.includes(B2_APPROVER_ROLE) as ReportValue),
        ...diffReportValues(
          "row-0.status",
          "active" as ReportValue,
          readField(revoked, "status", "row-0.revoked") as ReportValue,
        ),
        ...diffReportValues(
          "row-0.created-at-untouched",
          createdAt as ReportValue,
          readField(revoked, "created_at", "row-0.revoked") as ReportValue,
        ),
      ];
      rows.push(passedRow(0, "journey:role-grant-revoke", mismatches));
    } catch (err) {
      rows.push(failedRow(0, "journey:role-grant-revoke", err instanceof Error ? err.message : String(err)));
    }

    // Row 1: the guards reject loudly — last-owner demotion forbidden, unqualified role invalid.
    try {
      let demoteCode = "<no-throw>";
      try {
        await producer.setMemberRole(store, { team_id: team, member_user_id: owner, role: "-owner" }, { granted_by: owner });
      } catch (err) {
        demoteCode = readB2IdentityError(err, "row-1.demote").code;
      }
      let grammarCode = "<no-throw>";
      try {
        await producer.setMemberRole(
          store,
          { team_id: team, member_user_id: member, role: "approver" },
          { granted_by: owner },
        );
      } catch (err) {
        grammarCode = readB2IdentityError(err, "row-1.grammar").code;
      }
      const mismatches: ObservationMismatch[] = [
        ...diffReportValues("row-1.demote", "forbidden" as ReportValue, demoteCode as ReportValue),
        ...diffReportValues("row-1.grammar", "validation" as ReportValue, grammarCode as ReportValue),
      ];
      rows.push(passedRow(1, "journey:role-guards", mismatches));
    } catch (err) {
      rows.push(failedRow(1, "journey:role-guards", err instanceof Error ? err.message : String(err)));
    }

    // Row 2: member removal cascades — row retained as removed, team grants revoked, other-team grants live.
    try {
      const teamToken = b2BearerToken(2, "team-grant");
      const otherToken = b2BearerToken(2, "other-grant");
      await store.createMcpGrant({
        user_id: member,
        team_id: team,
        client_id: "b2-cli",
        token_sha256: await producer.sha256HexText(teamToken),
        expires_at: EXPIRES_AT,
      });
      await store.createMcpGrant({
        user_id: member,
        team_id: otherTeam,
        client_id: "b2-cli",
        token_sha256: await producer.sha256HexText(otherToken),
        expires_at: EXPIRES_AT,
      });
      const removed = await producer.removeMember(store, { team_id: team, member_user_id: member }, { removed_by: owner });
      const membership = await store.findMembership(team, member);
      const teamGrant = await store.findMcpGrantByTokenHash(await producer.sha256HexText(teamToken));
      const otherGrant = await store.findMcpGrantByTokenHash(await producer.sha256HexText(otherToken));
      if (teamGrant === null || otherGrant === null || membership === null) {
        throw new Error("row-2: removal deleted a row that must be retained (grants) or readable (membership)");
      }
      const mismatches: ObservationMismatch[] = [
        ...diffReportValues(
          "row-2.removed",
          true as ReportValue,
          (isRecord(removed) && removed["removed"] === true) as ReportValue,
        ),
        ...diffReportValues(
          "row-2.status",
          "removed" as ReportValue,
          readField(membership, "status", "row-2.membership") as ReportValue,
        ),
        ...diffReportValues(
          "row-2.team-grant-revoked",
          true as ReportValue,
          (readB2RevokedAt(teamGrant, "row-2.team-grant") !== null) as ReportValue,
        ),
        ...diffReportValues(
          "row-2.other-grant-live",
          null,
          readB2RevokedAt(otherGrant, "row-2.other-grant") as ReportValue,
        ),
      ];
      rows.push(passedRow(2, "journey:remove-member", mismatches));
    } catch (err) {
      rows.push(failedRow(2, "journey:remove-member", err instanceof Error ? err.message : String(err)));
    }

    // Row 3: session revocation is idempotent and preserves the original stamp; unknown tokens are no oracle.
    try {
      const token = b2BearerToken(3, "session");
      await store.createSession({
        user_id: member,
        token_sha256: await producer.sha256HexText(token),
        expires_at: EXPIRES_AT,
        last_team_id: team,
      });
      await producer.revokeSessionByToken(store, { token });
      const first = readB2RevokedAt(
        await store.findSessionByTokenHash(await producer.sha256HexText(token)),
        "row-3.first",
      );
      clock.advance(60_000);
      await producer.revokeSessionByToken(store, { token });
      const second = readB2RevokedAt(
        await store.findSessionByTokenHash(await producer.sha256HexText(token)),
        "row-3.second",
      );
      const unknown = await producer.revokeSessionByToken(store, { token: b2BearerToken(3, "unknown") });
      const unknownRow = await store.findSessionByTokenHash(await producer.sha256HexText(b2BearerToken(3, "unknown")));
      const mismatches: ObservationMismatch[] = [
        ...diffReportValues("row-3.revoked", true as ReportValue, (first !== null) as ReportValue),
        ...diffReportValues("row-3.stamp-preserved", first as ReportValue, second as ReportValue),
        ...diffReportValues(
          "row-3.unknown-idempotent",
          true as ReportValue,
          (isRecord(unknown) && unknown["revoked"] === true) as ReportValue,
        ),
        ...diffReportValues("row-3.unknown-absent", null, (unknownRow === null ? null : "present") as ReportValue),
      ];
      rows.push(passedRow(3, "journey:session-revoke", mismatches));
    } catch (err) {
      rows.push(failedRow(3, "journey:session-revoke", err instanceof Error ? err.message : String(err)));
    }

    // Row 4: sign-out-everywhere revokes all of one user's sessions and grants, and nobody else's.
    try {
      const memberSession = b2BearerToken(4, "member-session");
      const memberGrant = b2BearerToken(4, "member-grant");
      const ownerSession = b2BearerToken(4, "owner-session");
      await store.createSession({
        user_id: member,
        token_sha256: await producer.sha256HexText(memberSession),
        expires_at: EXPIRES_AT,
        last_team_id: null,
      });
      await store.createMcpGrant({
        user_id: member,
        team_id: null,
        client_id: "b2-cli",
        token_sha256: await producer.sha256HexText(memberGrant),
        expires_at: EXPIRES_AT,
      });
      await store.createSession({
        user_id: owner,
        token_sha256: await producer.sha256HexText(ownerSession),
        expires_at: EXPIRES_AT,
        last_team_id: null,
      });
      await producer.signOutEverywhere(store, { user_id: member });
      const sessionRow = await store.findSessionByTokenHash(await producer.sha256HexText(memberSession));
      const grantRow = await store.findMcpGrantByTokenHash(await producer.sha256HexText(memberGrant));
      const ownerRow = await store.findSessionByTokenHash(await producer.sha256HexText(ownerSession));
      if (sessionRow === null || grantRow === null || ownerRow === null) {
        throw new Error("row-4: sign-out deleted a row that must be retained with revoked_at");
      }
      const mismatches: ObservationMismatch[] = [
        ...diffReportValues(
          "row-4.session-revoked",
          true as ReportValue,
          (readB2RevokedAt(sessionRow, "row-4.session") !== null) as ReportValue,
        ),
        ...diffReportValues(
          "row-4.grant-revoked",
          true as ReportValue,
          (readB2RevokedAt(grantRow, "row-4.grant") !== null) as ReportValue,
        ),
        ...diffReportValues(
          "row-4.owner-untouched",
          null,
          readB2RevokedAt(ownerRow, "row-4.owner") as ReportValue,
        ),
      ];
      rows.push(passedRow(4, "journey:sign-out-everywhere", mismatches));
    } catch (err) {
      rows.push(failedRow(4, "journey:sign-out-everywhere", err instanceof Error ? err.message : String(err)));
    }

    builder.addCase({ kind: "table", operation: "b2.revocation.journey", rows });
    builder.addCase({ kind: "table", operation: "b2.revocation.blocked", rows: blockedRows() });

    const report = builder.build();
    expect(report.summary.passed).toBe(5);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.setupFailed).toBe(0);
    expect(report.summary.unsupported).toBe(2);
    for (const table of report.cases) {
      if (table.kind !== "table") {
        continue;
      }
      for (const row of table.rows) {
        expect(row.detail).toContain("local");
      }
    }
  }, 60000);
});
