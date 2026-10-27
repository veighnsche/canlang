/**
 * Aggregate receipt budget memoization trusts only validated provenance.
 *
 * `aggregateReceiptLimits` caches derived budgets by plan object identity so
 * the per-observation budget reads share one computation per installed plan.
 * TypeScript `readonly` is not runtime immutability: neither a shallow
 * `Object.freeze` nor even a full external deep-freeze proves a plan came
 * from the validated constructor, and `Object.values`-style walks cannot see
 * through getters (a frozen outer plan can serve a different frozen loop on
 * every access from closed-over state). This function also serves
 * replay/decoding helpers, so the cache trusts only its private witness set,
 * populated exclusively when the validated plan constructor deep-freezes its
 * own-data output (accessors, cycles, sparse arrays and exotic objects are
 * refused before inspection) and at the single hand-built install literal.
 * Anything else — mutable, shallow-frozen, externally frozen, getter-backed,
 * proxy or otherwise unproven objects, and replay's fresh-per-call decoded
 * plans — recomputes fully on every call and can never reuse stale budgets.
 * Failures are never cached.
 *
 * These tests exercise the real shipped modules through their built dist
 * entries with no mocks: untrusted plans go through `aggregateReceiptLimits`
 * directly, while trust is earned only through the real
 * `checkScenarioResultDisclosurePlan` validator.
 */
import { describe, expect, it } from "vitest";
import { aggregateReceiptLimits, checkScenarioResultDisclosurePlan } from "@canlang/state/invocation";

type Plan = Parameters<typeof aggregateReceiptLimits>[0];

const LOOP_ID = "a".repeat(64);
const QUERY_ID = "c".repeat(64);
const SOURCE = { path: "w.can", sha256: "b".repeat(64), module: "w" };

function makePlan(maximum: number): Plan {
  return {
    version: 1,
    source: SOURCE,
    returns: [
      {
        id: "r1",
        dependencies: [
          { id: "rd1", source: SOURCE, role: "data", model: "worker.Root", field: "sequence", type: "int", queryId: "q1" },
        ],
      },
    ],
    queries: [
      {
        id: "q1",
        source: SOURCE,
        model: "worker.Root",
        order: [],
        limit: null,
        archived: "exclude",
        dependencies: [{ id: "d1", source: SOURCE, role: "data", field: "sequence", type: "int" }],
        iteration: LOOP_ID,
      },
    ],
    sourceLoops: {
      loops: [{ id: LOOP_ID, maximum, writes: 1, sends: 0, aggregate: { queries: ["q1"], dependencies: [] } }],
    },
  } as unknown as Plan;
}

/** Minimal claim the real validator accepts: exact closed shapes, 64-hex
 * loop/query identities, spans containing the aggregate condition and
 * constructor, and an empty influence closure over plain dependencies. */
function makeValidClaim(maximum: number): unknown {
  return {
    version: 1,
    source: SOURCE,
    returns: [
      {
        id: "r1",
        source: SOURCE,
        dependencies: [
          { id: "rd1", source: SOURCE, role: "data", model: "worker.Root", field: "sequence", type: "int" },
        ],
        influences: [],
      },
    ],
    queries: [
      {
        id: QUERY_ID,
        source: SOURCE,
        model: "worker.Root",
        order: [],
        limit: null,
        archived: "exclude",
        dependencies: [{ id: "d1", source: SOURCE, role: "data", field: "sequence", type: "int" }],
        iteration: LOOP_ID,
      },
    ],
    sourceLoops: {
      source: SOURCE,
      owner: "worker.Root",
      loops: [
        {
          id: LOOP_ID,
          node: { start: 0, end: 100 },
          domain: { start: 0, end: 10 },
          maximum,
          parameter: "item",
          parentModel: "worker.Root",
          model: "worker.Item",
          filtered: false,
          item: "row",
          writes: 1,
          sends: 0,
          condition: { node: { start: 20, end: 40 }, statement: { start: 15, end: 90 } },
          aggregate: {
            queries: [QUERY_ID],
            dependencies: [],
            order: [{ field: "id", direction: "asc" }],
            write: {
              node: { start: 45, end: 60 },
              model: "worker.Item",
              parent: "worker.Root",
              fields: ["sequence"],
            },
          },
        },
      ],
    },
  };
}

function mutateMaximum(plan: Plan, maximum: number): void {
  (plan as any).sourceLoops.loops[0].maximum = maximum;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

describe("aggregateReceiptLimits provenance-witness cache", () => {
  it("recomputes a mutable plan after a same-reference mutation instead of reusing stale budgets", () => {
    const plan = makePlan(10);
    expect(aggregateReceiptLimits(plan)?.maxRows).toBe(220);
    mutateMaximum(plan, 20);
    const after = aggregateReceiptLimits(plan);
    expect(after?.maxRows).toBe(240);
  });

  it("recomputes a shallow-frozen plan after a nested mutation: freeze(outer) with maximum 10 then 20 yields 240, not stale 220", () => {
    const plan = Object.freeze(makePlan(10));
    expect(aggregateReceiptLimits(plan)?.maxRows).toBe(220);
    mutateMaximum(plan, 20);
    const after = aggregateReceiptLimits(plan);
    expect(after?.maxRows).toBe(240);
  });

  it("recomputes a getter-backed frozen plan that swaps its closed-over loops: maximum 10 then 20 yields 240, not stale 220", () => {
    const frozenLoops = (maximum: number) =>
      deepFreeze({
        loops: [{ id: LOOP_ID, maximum, writes: 1, sends: 0, aggregate: { queries: ["q1"], dependencies: [] } }],
      });
    let current = frozenLoops(10);
    const plan = makePlan(10) as Record<string, unknown>;
    Object.defineProperty(plan, "sourceLoops", { enumerable: true, configurable: true, get: () => current });
    // Deep-freeze every reachable data graph (including the getter's current
    // result) exactly as the review's repro does: the outer plan is fully
    // frozen, yet the accessor stays live and serves a different frozen loop
    // after the swap. A value-walk cannot tell this apart from real data.
    const frozen = deepFreeze(plan) as unknown as Plan;
    expect(aggregateReceiptLimits(frozen)?.maxRows).toBe(220);
    current = frozenLoops(20);
    const after = aggregateReceiptLimits(frozen);
    expect(after?.maxRows).toBe(240);
  });

  it("recomputes an externally deep-frozen but unvalidated plan instead of trusting the freeze", () => {
    const plan = deepFreeze(makePlan(10));
    const first = aggregateReceiptLimits(plan);
    expect(first?.maxRows).toBe(220);
    const second = aggregateReceiptLimits(plan);
    expect(second?.maxRows).toBe(220);
    expect(second).not.toBe(first);
  });

  it("shares one computation for a validator-constructed plan and keeps it tamper-evident", () => {
    const plan = checkScenarioResultDisclosurePlan(makeValidClaim(10));
    const first = aggregateReceiptLimits(plan);
    expect(first?.maxRows).toBe(220);
    expect(() => mutateMaximum(plan, 20)).toThrow();
    const second = aggregateReceiptLimits(plan);
    expect(second).toBe(first);
    expect(second?.maxRows).toBe(220);
  });

  it("refuses accessor-backed claims at the validator so no getter plan can earn trust", () => {
    const claim = makeValidClaim(10) as Record<string, unknown>;
    const loops = (claim as any).sourceLoops;
    Object.defineProperty(claim, "sourceLoops", { enumerable: true, configurable: true, get: () => loops });
    expect(() => checkScenarioResultDisclosurePlan(claim)).toThrow();
  });

  it("computes independently decoded equal plans independently", () => {
    const plan = makePlan(10);
    const replayed = makePlan(20);
    expect(aggregateReceiptLimits(plan)?.maxRows).toBe(220);
    const replayedLimits = aggregateReceiptLimits(replayed);
    expect(replayedLimits?.maxRows).toBe(240);
  });

  it("refuses invalid budgets on every call without caching the failure", () => {
    const mutable = makePlan(0);
    expect(() => aggregateReceiptLimits(mutable)).toThrow();
    expect(() => aggregateReceiptLimits(mutable)).toThrow();
    const frozen = deepFreeze(makePlan(0));
    expect(() => aggregateReceiptLimits(frozen)).toThrow();
    expect(() => aggregateReceiptLimits(frozen)).toThrow();
  });
});
