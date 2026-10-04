import { describe, expect, it } from "vitest";
import type { StoragePort } from "@canlang/contracts";
import { createContext } from "../src/runtime/context.js";

function fakeStore(): StoragePort {
  return {} as unknown as StoragePort;
}

describe("createContext", () => {
  it("defaults clock to Date.now and memberships to []", () => {
    const store = fakeStore();
    const c = createContext({ caller: { userId: "u1", roles: [] }, store });
    expect(typeof c.clock).toBe("function");
    const before = Date.now();
    const tick = c.clock();
    expect(tick).toBeGreaterThanOrEqual(before);
    expect(tick).toBeLessThanOrEqual(Date.now());
    expect(c.memberships).toEqual([]);
    expect(c.preferences).toEqual({});
    expect(c.caller).toEqual({ userId: "u1", roles: [] });
    expect(c.store).toBe(store);
  });

  it("honors an explicit clock and memberships", () => {
    const c = createContext({
      caller: { userId: "u9", roles: ["admin"] },
      store: fakeStore(),
      clock: () => 1700000000000,
      memberships: ["team-a", "team-b"],
    });
    expect(c.clock()).toBe(1700000000000);
    expect(c.memberships).toEqual(["team-a", "team-b"]);
    expect(c.caller.roles).toEqual(["admin"]);
  });
});
