import { describe, expect, it } from "vitest";
import {
  ConstructRanker,
  type JevChoiceRequest,
  type RankOccurrence,
} from "../src/dev/jev-ranker.js";
import type { ConstructHelpIndex } from "../src/dev/construct-help.js";

const cards = [
  { id: "can.v1.then.metric", section: "Then", signature: "metric <name>", meaning: "Show a count", availability: "working" as const },
  { id: "can.v1.then.list", section: "Then", signature: "list <name>", meaning: "Show records", availability: "working" as const },
];
const occurrence: RankOccurrence = {
  ref: "s1/r1/d0", revision: "r1", helpRevision: "h1", sourceHash: "a".repeat(64), span: { start: 20, end: 27 },
  diagnosticCode: "E1200", messageKind: "unrecognized_keyword", section: "Then", slot: "page_item",
  guess: "metrics", complete: true, omitted: 0, exactSourceSpan: true,
  structuralRecovery: false, candidateCoverage: "complete", unsupportedBehaviorProven: false,
  materialIntentChoice: false, evidenceSufficient: true, cards,
};

function answer(request: JevChoiceRequest, choice: string, probabilities: Record<string, number>, confidence = 0.9): unknown {
  expect(Object.keys(request.questions)).toEqual(["construct_for_occurrence"]);
  return {
    model: "jev-1.13.0",
    answers: { construct_for_occurrence: { type: "choice", choice, confidence, probabilities } },
    usage: { input_tokens: 42, output_tokens: 9 },
  };
}

describe("bounded construct ranking", () => {
  it("takes candidate coverage and availability from the captured help index", async () => {
    let calls = 0;
    const index = {
      revision: "h1",
      candidates: (_inventory: unknown, proofs: readonly unknown[]) => ({
        candidateCoverage: proofs.length ? "complete" : "unknown",
        cards: cards.map(card => ({ ...card, status: proofs.length ? "working" : "unavailable" })),
      }),
    } as unknown as ConstructHelpIndex;
    const ranker = new ConstructRanker({ choose: async request => {
      calls++;
      return answer(request, cards[0]!.id, {
        [cards[0]!.id]: 0.8, [cards[1]!.id]: 0.1, none: 0.05, unclear: 0.05,
      });
    } }, { allowExternal: () => true, isCurrent: () => true });
    const { helpRevision: _helpRevision, candidateCoverage: _candidateCoverage, cards: _cards, ...context } = occurrence;
    const inventory = {
      slot: "page_item", profile: "office-local-v1", compilerSha256: "b".repeat(64),
      indexRevision: "h1", ids: cards.map(card => card.id), complete: true,
    };
    expect(await ranker.rankQualified(context, index, inventory)).toMatchObject({ state: "candidate_coverage_unknown" });
    expect(calls).toBe(0);
    expect(await ranker.rankQualified(context, index, inventory, [{
      id: cards[0]!.id, indexRevision: "h1", profile: "office-local-v1", compilerSha256: "b".repeat(64),
      compilerCheck: "compiler-pass", runtimeCheck: "runtime-pass",
    }])).toMatchObject({ state: "likely" });
    expect(calls).toBe(1);
  });

  it("routes deterministic and unsafe contexts without calling Jev", async () => {
    let calls = 0;
    const ranker = new ConstructRanker({ choose: async () => { calls++; throw new Error("unexpected"); } }, {
      allowExternal: () => true, isCurrent: () => true,
    });
    expect(await ranker.rank({ ...occurrence, cards: [cards[0]!] })).toMatchObject({ state: "deterministic", card: cards[0] });
    expect(await ranker.rank({ ...occurrence, structuralRecovery: true })).toMatchObject({ state: "structural" });
    expect(await ranker.rank({ ...occurrence, materialIntentChoice: true })).toMatchObject({ state: "intent_required" });
    expect(await ranker.rank({ ...occurrence, evidenceSufficient: false })).toMatchObject({ state: "intent_unclear" });
    expect(await ranker.rank({ ...occurrence, candidateCoverage: "unknown" })).toMatchObject({ state: "candidate_coverage_unknown" });
    expect(await ranker.rank({ ...occurrence, cards: [], unsupportedBehaviorProven: true })).toMatchObject({ state: "none" });
    expect(await ranker.rank({ ...occurrence, cards: [] })).toMatchObject({ state: "candidate_coverage_unknown" });
    expect(calls).toBe(0);
  });

  it("does not return even a deterministic card for an old source/help revision", async () => {
    const ranker = new ConstructRanker({ choose: async () => { throw new Error("unexpected"); } }, {
      allowExternal: () => true, isCurrent: () => false,
    });
    expect(await ranker.rank({ ...occurrence, cards: [cards[0]!] })).toMatchObject({ state: "stale" });
  });

  it("accepts compiler slot spelling and bounds without weakening local eligibility", async () => {
    let calls = 0;
    const ranker = new ConstructRanker({ choose: async () => { calls++; throw new Error("unexpected"); } }, {
      allowExternal: () => false, isCurrent: () => true,
    });
    for (const slot of ["given.rule", "given-rule", "page_item", `a${"b".repeat(95)}`]) {
      expect(await ranker.rank({ ...occurrence, slot, cards: [cards[0]!] }))
        .toMatchObject({ state: "deterministic", card: cards[0] });
      expect(await ranker.rank({ ...occurrence, slot })).toMatchObject({ state: "ranking_disallowed" });
    }
    for (const slot of [null, "", ".given", "-given", "Given.rule", "given/rule", "given rule", "given\nrule", `a${"b".repeat(96)}`]) {
      expect(await ranker.rank({ ...occurrence, slot, cards: [cards[0]!] })).toMatchObject({ state: "structural" });
    }
    expect(await ranker.rank({ ...occurrence, slot: "given.rule", structuralRecovery: true }))
      .toMatchObject({ state: "structural" });
    expect(await ranker.rank({ ...occurrence, slot: "given.rule", cards: [], unsupportedBehaviorProven: true }))
      .toMatchObject({ state: "none" });
    expect(calls).toBe(0);
  });

  it("sends only bounded structured evidence, validates a rank, and caches it", async () => {
    let calls = 0;
    const ranker = new ConstructRanker({ choose: async (request) => {
      calls++;
      expect(request.state).toMatchObject({ diagnostic_code: "E1200", guess: "metrics", slot: "page_item", span: { start: 20, end: 27 } });
      expect(JSON.stringify(request)).not.toContain("private source value");
      expect(Object.keys(request.questions.construct_for_occurrence.criteria).sort()).toEqual([
        "can.v1.then.list", "can.v1.then.metric", "none", "unclear",
      ]);
      return answer(request, cards[0]!.id, {
        [cards[0]!.id]: 0.8, [cards[1]!.id]: 0.1, none: 0.05, unclear: 0.05,
      });
    } }, { allowExternal: () => true, isCurrent: () => true });
    expect(await ranker.rank(occurrence)).toMatchObject({ state: "likely", card: cards[0], probability: 0.8 });
    expect(await ranker.rank(occurrence)).toMatchObject({ state: "likely" });
    expect(calls).toBe(1);
  });

  it("abstains on ambiguous or malformed provider answers and respects disclosure", async () => {
    const disallowed = new ConstructRanker({ choose: async () => { throw new Error("unexpected"); } }, {
      allowExternal: () => false, isCurrent: () => true,
    });
    expect(await disallowed.rank(occurrence)).toMatchObject({ state: "ranking_disallowed" });
    const unclear = new ConstructRanker({ choose: async request => answer(request, cards[0]!.id, {
      [cards[0]!.id]: 0.5, [cards[1]!.id]: 0.4, none: 0.05, unclear: 0.05,
    }) }, { allowExternal: () => true, isCurrent: () => true });
    expect(await unclear.rank(occurrence)).toMatchObject({ state: "intent_unclear" });
    const invalid = new ConstructRanker({ choose: async request => answer(request, cards[0]!.id, {
      [cards[0]!.id]: 0.9, [cards[1]!.id]: 0.1,
    }) }, { allowExternal: () => true, isCurrent: () => true });
    expect(await invalid.rank(occurrence)).toEqual({ state: "ranking_unavailable", reason: "invalid_response" });
  });

  it("returns pending within the inline budget and discards an old revision", async () => {
    let resolveChoice: ((value: unknown) => void) | undefined;
    let current = true;
    const ranker = new ConstructRanker({ choose: () => new Promise(resolve => { resolveChoice = resolve; }) }, {
      allowExternal: () => true, isCurrent: () => current, inlineBudgetMs: 1, providerDeadlineMs: 100,
    });
    const pending = await ranker.rank(occurrence);
    expect(pending).toMatchObject({ state: "pending" });
    current = false;
    expect(ranker.lookup(pending.state === "pending" ? pending.ref : "")).toMatchObject({ state: "stale" });
    resolveChoice?.(answer({ questions: { construct_for_occurrence: { type: "choice", instructions: "", criteria: Object.fromEntries([...cards.map(card => card.id), "none", "unclear"].map(id => [id, ""])) } }, model: "jev-latest", state: {} }, cards[0]!.id, {
      [cards[0]!.id]: 0.8, [cards[1]!.id]: 0.1, none: 0.05, unclear: 0.05,
    }));
  });

  it("bounds an uncooperative provider by its deadline", async () => {
    const ranker = new ConstructRanker({ choose: () => new Promise(() => {}) }, {
      allowExternal: () => true, isCurrent: () => true, inlineBudgetMs: 1, providerDeadlineMs: 5,
    });
    const pending = await ranker.rank(occurrence);
    expect(pending.state).toBe("pending");
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(ranker.lookup(pending.state === "pending" ? pending.ref : "")).toEqual({ state: "ranking_unavailable", reason: "timeout" });
  });
});

it("cancels bounded retained calls on eviction and closes without awaiting an uncooperative transport", async () => {
  const signals: AbortSignal[] = [];
  const ranker = new ConstructRanker({ choose: (_request, signal) => {
    signals.push(signal); return new Promise(() => {});
  } }, { allowExternal: () => true, isCurrent: () => true, inlineBudgetMs: 1, providerDeadlineMs: 10000, maxCache: 1 });
  const first = await ranker.rank(occurrence);
  const second = await ranker.rank({ ...occurrence, ref: "s1/r1/d1" });
  expect(first.state).toBe("pending");
  expect(second.state).toBe("pending");
  expect(signals[0]!.aborted).toBe(true);
  expect(ranker.lookup(first.state === "pending" ? first.ref : "")).toMatchObject({ state: "ranking_unavailable", reason: "invalid_response" });
  ranker.close();
  expect(signals[1]!.aborted).toBe(true);
  expect(ranker.lookup(second.state === "pending" ? second.ref : "")).toMatchObject({ state: "ranking_unavailable", reason: "cancelled" });
  expect(await ranker.rank(occurrence)).toMatchObject({ state: "ranking_unavailable", reason: "cancelled" });
});
