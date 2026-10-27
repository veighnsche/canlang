/**
 * Aggregate receipt budget memoization trusts only frozen plans.
 *
 * `aggregateReceiptLimits` caches derived budgets by plan object identity so
 * the per-observation budget reads share one computation per installed plan.
 * TypeScript `readonly` is not runtime immutability, and this function also
 * serves replay/decoding helpers, so a reused mutable plan must never reuse
 * prior budgets: unfrozen inputs bypass the cache and revalidate fully on
 * every call, while deeply frozen installed plans share their computation.
 * Replay decodes a fresh plan object per call and always recomputes.
 *
 * These tests use small hand-built plans through the real validator
 * (`checkQueries` runs inside the derivation) with no mocks: a same-reference
 * mutation must be reflected on the next call (stale reuse fails closed the
 * wrong way), frozen plans are tamper-evident, and independently decoded
 * equal plans compute independently.
 */
import { describe, expect, it } from "vitest";
import { aggregateReceiptLimits } from "@canlang/state/invocation/scenario-query-plan";

type Plan = Parameters<typeof aggregateReceiptLimits>[0];

const LOOP_ID = "a".repeat(64);
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

describe("aggregateReceiptLimits frozen-witness cache", () => {
  it("recomputes a mutable plan after a same-reference mutation instead of reusing stale budgets", () => {
    const plan = makePlan(10);
    const before = aggregateReceiptLimits(plan);
    expect(before?.maxRows).toBe(220);
    (plan as any).sourceLoops.loops[0].maximum = 20;
    const after = aggregateReceiptLimits(plan);
    expect(after?.maxRows).toBe(240);
    expect(after).not.toBe(before);
  });

  it("returns equal budgets for repeated unfrozen calls without sharing identity", () => {
    const plan = makePlan(10);
    const first = aggregateReceiptLimits(plan);
    const second = aggregateReceiptLimits(plan);
    expect(second).toEqual(first);
    expect(second?.maxRows).toBe(220);
  });

  it("keeps frozen plans tamper-evident and shares their computation", () => {
    const plan = deepFreeze(makePlan(10));
    const first = aggregateReceiptLimits(plan);
    expect(first?.maxRows).toBe(220);
    expect(() => {
      (plan as any).sourceLoops.loops[0].maximum = 20;
    }).toThrow();
    const second = aggregateReceiptLimits(plan);
    expect(second).toBe(first);
    expect(second?.maxRows).toBe(220);
  });

  it("computes independently decoded equal plans independently", () => {
    const plan = makePlan(10);
    const replayed = makePlan(10);
    const first = aggregateReceiptLimits(plan);
    expect(first?.maxRows).toBe(220);
    (plan as any).sourceLoops.loops[0].maximum = 99;
    const replayedLimits = aggregateReceiptLimits(replayed);
    expect(replayedLimits?.maxRows).toBe(220);
    const mutated = aggregateReceiptLimits(plan);
    expect(mutated?.maxRows).toBe(200 + 99 * 2);
  });

  it("refuses invalid budgets on every call without caching the failure", () => {
    const plan = makePlan(0);
    expect(() => aggregateReceiptLimits(plan)).toThrow();
    expect(() => aggregateReceiptLimits(plan)).toThrow();
  });
});
