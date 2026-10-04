import { describe, expect, it } from "vitest";
import { SeedRefError, parseSeedRef, parseSeedRefs } from "../src/fixtures/seeds.js";

describe("parseSeedRef", () => {
  it("parses provider:scenario refs", () => {
    expect(parseSeedRef("mail:send-retry-success")).toEqual({
      provider: "mail",
      scenario: "send-retry-success",
    });
    expect(parseSeedRef("files9:up-load-2")).toEqual({ provider: "files9", scenario: "up-load-2" });
  });

  it.each([
    ["", "exactly one"],
    ["mail", "exactly one"],
    ["mail:send:extra", "exactly one"],
    [":", "empty"],
    ["::", "exactly one"],
    [":send", "provider is empty"],
    ["mail:", "scenario is empty"],
    ["Mail:send", "kebab-case"],
    ["mail:Send", "kebab-case"],
    ["mail:sénd", "kebab-case"],
    ["9mail:send", "kebab-case"],
    ["mail:send_ok", "kebab-case"],
    ["mail:send ok", "kebab-case"],
    ["mail:-send", "kebab-case"],
    ["mail:send-", "kebab-case"],
    ["mail:se--nd", "kebab-case"],
  ])("rejects %j (%s)", (ref, fragment) => {
    expect(() => parseSeedRef(ref)).toThrow(SeedRefError);
    expect(() => parseSeedRef(ref)).toThrow(fragment);
  });

  it("accepts single-char segments", () => {
    expect(parseSeedRef("a:b")).toEqual({ provider: "a", scenario: "b" });
  });

  it("accepts long segments without catastrophic backtracking", () => {
    const provider = "m".repeat(500);
    const scenario = "s".repeat(500);
    expect(parseSeedRef(`${provider}:${scenario}`)).toEqual({ provider, scenario });
  });

  it("carries the ref and a reason", () => {
    try {
      parseSeedRef("MAIL:x");
      expect.unreachable("must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SeedRefError);
      expect((err as SeedRefError).ref).toBe("MAIL:x");
      expect((err as Error).message).toContain("MAIL:x");
    }
  });
});

describe("parseSeedRefs", () => {
  it("parses lists and rejects duplicates", () => {
    expect(parseSeedRefs([])).toEqual([]);
    expect(parseSeedRefs(["mail:send-ok", "files:up-ok"])).toEqual([
      { provider: "mail", scenario: "send-ok" },
      { provider: "files", scenario: "up-ok" },
    ]);
    expect(() => parseSeedRefs(["mail:send-ok", "mail:send-ok"])).toThrow(SeedRefError);
    expect(() => parseSeedRefs(["mail:send-ok", "mail:send-ok"])).toThrow(/duplicate/);
  });
});
