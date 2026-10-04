import { describe, expect, it } from "vitest";
import {
  provisionRowAccounts,
  resolveCaller,
} from "../src/fixtures/accounts.js";

describe("row accounts", () => {
  it("provisions deterministic distinct accounts per row", () => {
    const first = provisionRowAccounts(0, [{ name: "reviewer", roles: ["reviewer"] }]);
    const repeat = provisionRowAccounts(0, [{ name: "reviewer", roles: ["reviewer"] }]);
    const second = provisionRowAccounts(1, [{ name: "reviewer", roles: ["reviewer"] }]);
    expect(repeat).toEqual(first);
    expect(new Set([first.self, first.other, first.outsider]).size).toBe(3);
    expect(second.self).not.toBe(first.self);
    expect(second.users["reviewer"]?.account).not.toBe(first.users["reviewer"]?.account);
  });

  it("resolves every caller selection without inventing grants", () => {
    const accounts = provisionRowAccounts(3, [{ name: "lead", roles: ["owner", "reviewer"] }]);
    expect(resolveCaller({ kind: "self" }, accounts)).toEqual({
      account: "row-3-self",
      team: "current",
      roles: ["members"],
      authenticated: true,
    });
    expect(resolveCaller({ kind: "outsider" }, accounts)).toEqual({
      account: "row-3-outsider",
      team: "current",
      roles: [],
      authenticated: true,
    });
    expect(resolveCaller({ kind: "public" }, accounts).authenticated).toBe(false);
    expect(resolveCaller({ kind: "fixture", fixture: "lead" }, accounts)).toEqual({
      account: "row-3-user-lead",
      team: "current",
      roles: ["owner", "reviewer"],
      authenticated: true,
    });
    expect(resolveCaller({ kind: "membership", roles: ["owner"] }, accounts).roles).toEqual([
      "owner",
    ]);
  });

  it("rejects unknown fixtures and empty roles as setup errors", () => {
    const accounts = provisionRowAccounts(0);
    expect(() => resolveCaller({ kind: "fixture", fixture: "ghost" }, accounts)).toThrow(
      /unknown user fixture/,
    );
    expect(() => resolveCaller({ kind: "membership", roles: [] }, accounts)).toThrow(
      /at least one non-empty role/,
    );
  });
});
