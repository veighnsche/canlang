/**
 * P-C production `McpPermissions` tests (`src/runtime/mcp-permissions.ts`).
 *
 * Failing-first: written before the module existed. Proves the
 * admit/deny matrix: active team members are admitted on known
 * operations; every other shape — anonymous, app-only (team null),
 * no membership, removed membership, foreign-team binding mismatch,
 * principal mismatch, unknown operation — is denied. Never fail-open.
 *
 * The `RealMcpPermissions` conformance assertion below compiles only
 * when the factory result satisfies the REAL interfaces `ports.ts`
 * type (same pattern as `mcp-route.test.ts`).
 */
import { describe, expect, it } from "vitest";
import type { CompileArtifact, ResolvedIdentity } from "@canlang/contracts";
import type { McpPermissions as RealMcpPermissions } from "@canlang/interfaces";
import { createMemberMcpPermissions } from "../src/runtime/mcp-permissions.js";

const READ_OP = "acme.Todo.read";
const MUT_OP = "acme.Todo.create";

function fixtureArtifact(): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "mcp-permissions-fixture/0 (hand-written; NOT compiler output)",
    tool_version: "mcp-permissions-fixture/0",
    sources: [],
    modules: [],
    callables: [],
    pages: [],
    requires: [],
    tests: [],
    operations: [
      { name: READ_OP, kind: "read", description: "Read todos.", inputs: { fields: [] } },
      { name: MUT_OP, kind: "create", description: "Create a todo.", inputs: { fields: [] } },
    ],
  } as unknown as CompileArtifact;
}

function memberIdentity(): ResolvedIdentity {
  return {
    actor: { user_id: "u-ada", email: "ada@test.example", email_verified: true },
    team: { team_id: "t-app", timezone: "UTC", created_at: "2026-10-04T15:00:00.000Z" },
    membership: {
      membership_id: "m-1",
      team_id: "t-app",
      user_id: "u-ada",
      is_owner: false,
      roles: [],
      status: "active",
      created_at: "2026-10-04T15:00:00.000Z",
      updated_at: "2026-10-04T15:00:00.000Z",
    },
    binding: { kind: "mcp_grant", grant_id: "g-1" },
    admitted_at: "2026-10-04T15:00:00.000Z",
  };
}

describe("createMemberMcpPermissions", () => {
  it("satisfies the real interfaces McpPermissions type", () => {
    const conforms: RealMcpPermissions = createMemberMcpPermissions(fixtureArtifact());
    expect(typeof conforms.canDiscover).toBe("function");
    expect(typeof conforms.canCall).toBe("function");
  });

  it("admits active team members on known operations (discover + call)", async () => {
    const permissions = createMemberMcpPermissions(fixtureArtifact());
    const identity = memberIdentity();
    for (const op of [READ_OP, MUT_OP]) {
      expect(await permissions.canDiscover(identity, op)).toBe(true);
      expect(await permissions.canCall(identity, op)).toBe(true);
    }
  });

  it("denies outsiders: anonymous, app-only, missing, removed, mismatched", async () => {
    const permissions = createMemberMcpPermissions(fixtureArtifact());
    const member = memberIdentity();
    const outsiders: Array<[string, ResolvedIdentity]> = [
      ["anonymous", { ...member, actor: null, membership: null }],
      ["app-only grant (team null)", { ...member, team: null, membership: null }],
      ["no membership", { ...member, membership: null }],
      [
        "removed membership",
        member.membership === null
          ? member
          : { ...member, membership: { ...member.membership, status: "removed" } },
      ],
      [
        "foreign-team binding mismatch",
        member.membership === null
          ? member
          : { ...member, membership: { ...member.membership, team_id: "t-foreign" } },
      ],
      [
        "principal mismatch",
        member.membership === null
          ? member
          : { ...member, membership: { ...member.membership, user_id: "u-mallory" } },
      ],
    ];
    expect(member.membership === null).toBe(false);
    for (const [label, identity] of outsiders) {
      expect(await permissions.canDiscover(identity, READ_OP), `discover: ${label}`).toBe(false);
      expect(await permissions.canCall(identity, READ_OP), `call: ${label}`).toBe(false);
      expect(await permissions.canDiscover(identity, MUT_OP), `discover: ${label}`).toBe(false);
      expect(await permissions.canCall(identity, MUT_OP), `call: ${label}`).toBe(false);
    }
  });

  it("denies unknown operations even for members (closed world)", async () => {
    const permissions = createMemberMcpPermissions(fixtureArtifact());
    const identity = memberIdentity();
    expect(await permissions.canDiscover(identity, "nope.unknown")).toBe(false);
    expect(await permissions.canCall(identity, "nope.unknown")).toBe(false);
    expect(await permissions.canDiscover(identity, "")).toBe(false);
    expect(await permissions.canCall(identity, "")).toBe(false);
  });

  it("denies a malformed identity instead of throwing (fail-closed)", async () => {
    const permissions = createMemberMcpPermissions(fixtureArtifact());
    for (const malformed of [null, undefined, {}, { actor: null }, "member"] as unknown[]) {
      expect(await permissions.canDiscover(malformed as ResolvedIdentity, READ_OP)).toBe(false);
      expect(await permissions.canCall(malformed as ResolvedIdentity, READ_OP)).toBe(false);
    }
  });

  it("deny-closed when the artifact has no operations[] (registry parity)", async () => {
    const bare = fixtureArtifact() as unknown as Record<string, unknown>;
    delete bare["operations"];
    const permissions = createMemberMcpPermissions(bare as unknown as CompileArtifact);
    const identity = memberIdentity();
    expect(await permissions.canDiscover(identity, READ_OP)).toBe(false);
    expect(await permissions.canCall(identity, READ_OP)).toBe(false);
  });

  it("fails loud on malformed operations entries (registry parity)", () => {
    const bad = fixtureArtifact() as unknown as { operations: unknown[] };
    bad.operations = [{ name: "", kind: "read", description: "x", inputs: { fields: [] } }];
    expect(() => createMemberMcpPermissions(bad as unknown as CompileArtifact)).toThrow(
      /operations\[0\]\.name/,
    );
    const notArray = fixtureArtifact() as unknown as Record<string, unknown>;
    notArray["operations"] = "read-everything";
    expect(() => createMemberMcpPermissions(notArray as unknown as CompileArtifact)).toThrow(
      /operations.*array/,
    );
  });
});
