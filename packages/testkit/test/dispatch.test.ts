import { describe, expect, it } from "vitest";
import {
  createExampleHooks,
  populateLiveScope,
  stepCallToDispatchRequest,
  type DispatchRequest,
} from "../src/runner/dispatch.js";
import type { StepCall } from "../src/runner/steps.js";
import type { RowScope } from "../src/runner/table.js";

const SCOPE = {
  snapshot: async () => null,
  dispose: async () => {},
} satisfies RowScope;

function stepCall(overrides: Partial<StepCall> = {}): StepCall {
  return { operation: "Todo.create", inputs: { title: "t" }, by: "s1", scope: SCOPE, ...overrides };
}

describe("stepCallToDispatchRequest", () => {
  it("normalizes well-formed calls and rejects malformed ones loud", () => {
    expect(stepCallToDispatchRequest(stepCall())).toEqual({
      operation: "Todo.create",
      inputs: { title: "t" },
      caller: "s1",
    });
    expect(() => stepCallToDispatchRequest(stepCall({ operation: "" }))).toThrow(
      /no operation identity/,
    );
    for (const inputs of [null, [], "x", 7]) {
      expect(() => stepCallToDispatchRequest(stepCall({ inputs }))).toThrow(
        /inputs that are not an object/,
      );
    }
    for (const by of [null, undefined]) {
      expect(() => stepCallToDispatchRequest(stepCall({ by }))).toThrow(/has no caller/);
    }
  });
});

describe("populateLiveScope", () => {
  it("prefers live values and falls back to static ones", async () => {
    const scope = await populateLiveScope(
      ["a", "b", "c"],
      (name) => (name === "a" ? { live: 1 } : undefined),
      new Map([
        ["b", { static: 2 }],
        ["a", { static: "ignored" }],
      ]),
    );
    expect(scope.get("a")).toEqual({ live: 1 });
    expect(scope.get("b")).toEqual({ static: 2 });
    expect(scope.get("c")).toBeUndefined();
  });

  it("propagates reader failures with fixture identity", async () => {
    await expect(
      populateLiveScope(
        ["x"],
        () => {
          throw new Error("store offline");
        },
        new Map(),
      ),
    ).rejects.toThrow(/live read of fixture "x" failed: store offline/);
  });
});

describe("createExampleHooks", () => {
  it("dispatches normalized calls and observes populated scopes", async () => {
    const requests: DispatchRequest[] = [];
    const hooks = createExampleHooks({
      dispatch: async (request) => {
        requests.push(request);
        return { ok: true };
      },
      readLive: (name) => (name === "author" ? { name: "live" } : undefined),
    });
    if (hooks.invokeCall === undefined || hooks.observeScope === undefined) {
      throw new Error("expected both hooks");
    }
    await hooks.invokeCall(stepCall());
    expect(requests).toEqual([{ operation: "Todo.create", inputs: { title: "t" }, caller: "s1" }]);
    const stashed = {
      fixtures: new Map<string, unknown>([
        ["author", { name: "static" }],
        ["plain", 1],
      ]),
      inputs: null,
      cells: [],
      expectedValues: [],
    };
    const scope = (await hooks.observeScope(SCOPE, stashed)) as ReadonlyMap<string, unknown>;
    expect(scope.get("author")).toEqual({ name: "live" });
    expect(scope.get("plain")).toBe(1);
  });
});
