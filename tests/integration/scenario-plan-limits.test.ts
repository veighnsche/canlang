/**
 * Aggregate receipt budget memoization trusts only a private frozen witness.
 *
 * `aggregateReceiptLimits` caches derived budgets by plan object identity so
 * the per-observation budget reads share one computation per installed plan.
 * TypeScript `readonly` is not runtime immutability — not even a shallow
 * `Object.freeze` proves the nested sourceLoops/queries/returns cannot
 * change — and this function also serves replay/decoding helpers, so the
 * cache trusts only its private witness set of proven deeply immutable
 * plans. A same-reference mutation must be reflected on the next call:
 * mutable and shallow-frozen plans recompute fully every time and never
 * reuse stale budgets, while replay's fresh-per-call decoded plans always
 * recompute and failures are never cached.
 *
 * These tests exercise the real shipped module through its built dist entry
 * with hand-built plans through the real validator (`checkQueries` runs
 * inside the derivation) and no mocks.
 */
import { describe, expect, it } from "vitest";
import { aggregateReceiptLimits } from "../../packages/state/dist/src/invocation/scenario-query-plan.js";

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

describe("aggregateReceiptLimits frozen-witness cache", () => {
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

  it("shares one computation for a proven deeply frozen plan and keeps it tamper-evident", () => {
    const plan = deepFreeze(makePlan(10));
    const first = aggregateReceiptLimits(plan);
    expect(first?.maxRows).toBe(220);
    expect(() => mutateMaximum(plan, 20)).toThrow();
    const second = aggregateReceiptLimits(plan);
    expect(second).toBe(first);
    expect(second?.maxRows).toBe(220);
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
