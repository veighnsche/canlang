import type { ResolvedCaller } from "@canlang/contracts";

export interface NamedUserFixture {
  name: string;
  roles: readonly string[];
}

/** Deterministic opaque account IDs provisioned for one isolated row. */
export interface RowAccounts {
  self: string;
  other: string;
  outsider: string;
  users: Readonly<Record<string, { account: string; roles: readonly string[] }>>;
}

/**
 * Deterministic per-row accounts. IDs embed the row index so separate rows
 * never share accounts or grants, and internal retries reproduce them.
 */
export function provisionRowAccounts(
  rowIndex: number,
  userFixtures: readonly NamedUserFixture[] = [],
): RowAccounts {
  const users: Record<string, { account: string; roles: readonly string[] }> = {};
  for (const fixture of userFixtures) {
    if (fixture.name in users) {
      throw new Error(`duplicate user fixture name: ${fixture.name}`);
    }
    users[fixture.name] = {
      account: `row-${rowIndex}-user-${fixture.name}`,
      roles: [...fixture.roles],
    };
  }
  return {
    self: `row-${rowIndex}-self`,
    other: `row-${rowIndex}-other`,
    outsider: `row-${rowIndex}-outsider`,
    users,
  };
}

export type CallerSelection =
  | { kind: "self" }
  | { kind: "other" }
  | { kind: "outsider" }
  | { kind: "public" }
  | { kind: "fixture"; fixture: string }
  | { kind: "membership"; roles: readonly string[] };

/**
 * Resolves a caller selection to an opaque identity. `outsider` runs against
 * the row's current-team data with no grants there (the runner never switches
 * the data under test). Throws on unknown fixtures or malformed roles; the
 * runner maps that to `setup-failed`. Role-name existence against
 * declarations joins with lane 1; only shape is validated here.
 */
export function resolveCaller(selection: CallerSelection, accounts: RowAccounts): ResolvedCaller {
  switch (selection.kind) {
    case "self":
      return { account: accounts.self, team: "current", roles: ["members"], authenticated: true };
    case "other":
      return { account: accounts.other, team: "current", roles: ["members"], authenticated: true };
    case "outsider":
      return { account: accounts.outsider, team: "current", roles: [], authenticated: true };
    case "public":
      return { account: "public", team: null, roles: [], authenticated: false };
    case "membership": {
      if (selection.roles.length === 0 || selection.roles.some((role) => role.length === 0)) {
        throw new Error("membership caller needs at least one non-empty role");
      }
      return {
        account: accounts.self,
        team: "current",
        roles: [...selection.roles],
        authenticated: true,
      };
    }
    case "fixture": {
      const user = accounts.users[selection.fixture];
      if (user === undefined) {
        throw new Error(`unknown user fixture caller: ${selection.fixture}`);
      }
      // DESIGN §5.1: omission or [] grants ordinary membership; membership is implicit.
      const roles = user.roles.length === 0 ? ["members"] : [...user.roles];
      return { account: user.account, team: "current", roles, authenticated: true };
    }
  }
}
