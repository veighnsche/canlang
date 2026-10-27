/**
 * Aggregate receipt budget memoization trusts only a private frozen witness.
 *
 * `aggregateReceiptLimits` caches derived budgets by plan object identity so
 * the per-observation budget reads share one computation per installed plan.
 * TypeScript `readonly` is not runtime immutability — not even a shallow
 * `Object.freeze` proves the nested sourceLoops/queries/returns cannot
 * change — and this function also serves replay/decoding helpers, so the
 * cache trusts only its private witness set: the first lookup for an object
 * deep-freezes it (tamper-evident henceforth) and records it, while anything
 * not witnessed recomputes fully. A same-reference mutation afterwards
 * throws instead of reusing stale budgets, and replay's fresh-per-call
 * decoded plans always recompute.
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

describe("aggregateReceiptLimits frozen-witness cache", () => {
  it("freezes a mutable plan on first lookup so a same-reference mutation throws instead of reusing stale budgets", () => {
    const plan = makePlan(10);
    const before = aggregateReceiptLimits(plan);
    expect(before?.maxRows).toBe(220);
    expect(() => {
      (plan as any).sourceLoops.loops[0].maximum = 20;
    }).toThrow();
    const after = aggregateReceiptLimits(plan);
    expect(after).toBe(before);
    expect(after?.maxRows).toBe(220);
  });

  it("closes the shallow-freeze hole: a top-level frozen plan cannot change nested loops afterwards", () => {
    const plan = Object.freeze(makePlan(10));
    const before = aggregateReceiptLimits(plan);
    expect(before?.maxRows).toBe(220);
    expect(() => {
      (plan as any).sourceLoops.loops[0].maximum = 20;
    }).toThrow();
    const after = aggregateReceiptLimits(plan);
    expect(after).toBe(before);
    expect(after?.maxRows).toBe(220);
  });

  it("computes independently decoded equal plans independently", () => {
    const plan = makePlan(10);
    const replayed = makePlan(20);
    const first = aggregateReceiptLimits(plan);
    expect(first?.maxRows).toBe(220);
    const replayedLimits = aggregateReceiptLimits(replayed);
    expect(replayedLimits?.maxRows).toBe(240);
    expect(replayedLimits).not.toBe(first);
  });

  it("refuses invalid budgets on every call without caching the failure", () => {
    const plan = makePlan(0);
    expect(() => aggregateReceiptLimits(plan)).toThrow();
    expect(() => aggregateReceiptLimits(plan)).toThrow();
  });
});
