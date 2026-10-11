import { describe, expect, it } from "vitest";
import {
  ConstructRanker,
  type JevChoiceRequest,
  type RankOccurrence,
} from "../src/dev/jev-ranker.js";
import type { ConstructHelpIndex } from "../src/dev/construct-help.js";
import { createHash } from 'node:crypto';
import { captureConstructEvidence, OFFICE_COLUMN_INTENT, validAuthorIntent } from '../src/dev/construct-evidence.js';

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
  it('joins only captured Office evidence and explicit column intent, retaining cache identity', async () => {
    const source = 'app PrivateOffice\nGiven\n SecretSupply {name:text,quantity:int?,available:bool=true}\nThen\n page / title="private secret title"\n  stock_rows SecretSupply empty="private secret empty" ## private commentary\n   text row.name,row.quantity,row.available\n';
    const hash = createHash('sha256').update(source).digest('hex');
    const start = Buffer.byteLength(source.slice(0,source.indexOf('stock_rows')));
    const span = {start,end:start+10};
    const capture = (text=source,intent:string|undefined=OFFICE_COLUMN_INTENT) =>
      captureConstructEvidence(text,hash,span,'stock_rows',intent)!;
    const evidence = capture();
    expect(evidence.sourceWindow.logicalLines).toBeLessThanOrEqual(5);
    expect(evidence.sourceWindow.bytesBeforeRedaction).toBeLessThanOrEqual(1024);
    for (const secret of ['PrivateOffice','SecretSupply','private secret','private commentary']) {
      expect(JSON.stringify(evidence)).not.toContain(secret);
    }
    expect(captureConstructEvidence(`${source}edit`,hash,span,'stock_rows',OFFICE_COLUMN_INTENT)).toBeNull();
    expect(captureConstructEvidence(source,hash,{start:start+1,end:start+11},'stock_rows')).toBeNull();
    const officeCards = cards.map((card,index)=>({...card,id:index===0?'can.v1.ui.list':'can.v1.ui.table'}));
    const office = {...occurrence,sourceHash:hash,span,messageKind:'unknown_collection_presentation',
      slot:'then.collection-presentation',guess:'stock_rows',materialIntentChoice:true,evidenceSufficient:false,
      cards:officeCards,evidence};
    let calls = 0;
    const requests:JevChoiceRequest[]=[];
    const ranker = new ConstructRanker({choose:async request=>{
      calls++;requests.push(request);
      expect(request.state.author_intent).toEqual({label:'author_intent_data',text:OFFICE_COLUMN_INTENT});
      return answer(request,officeCards[1]!.id,{[officeCards[0]!.id]:0.1,[officeCards[1]!.id]:0.8,none:0.05,unclear:0.05});
    }},{allowExternal:()=>true,isCurrent:()=>true});
    expect(await ranker.rank({...office,evidence:captureConstructEvidence(source,hash,span,'stock_rows')!})).toMatchObject({state:'intent_required'});
    expect(await ranker.rank({...office,evidence:capture(source,'Show supplies.')})).toMatchObject({state:'intent_required'});
    expect(await ranker.rank({...office,messageKind:'unsafe_when'})).toMatchObject({state:'intent_required'});
    expect(await ranker.rank({...office,section:null})).toMatchObject({state:'structural'});
    expect(await ranker.rank({...office,candidateCoverage:'unknown'})).toMatchObject({state:'candidate_coverage_unknown'});
    expect(await ranker.rank({...office,cards:officeCards.map(card=>({...card,availability:'unavailable' as const}))}))
      .toMatchObject({state:'candidate_coverage_unknown'});
    expect(await ranker.rank({...office,evidence:{...evidence,sourceSha256:'b'.repeat(64)}})).toMatchObject({state:'ineligible'});
    expect(calls).toBe(0);
    expect(await ranker.rank(office)).toMatchObject({state:'likely',card:officeCards[1]});
    expect(requests[0]!.state.source_window).toEqual(evidence.sourceWindow);
    expect(await ranker.rank(office)).toMatchObject({state:'likely'});
    expect(calls).toBe(1);
    expect(await ranker.rank({...office,evidence:{...evidence,sourceWindow:{...evidence.sourceWindow,truncated:true}}}))
      .toMatchObject({state:'intent_required'});
    // A changed bounded packet gets a different request/cache even within one revision.
    expect(await ranker.rank({...office,evidence:{...evidence,sourceWindow:{...evidence.sourceWindow,text:`${evidence.sourceWindow.text} `}}}))
      .toMatchObject({state:'likely'});
    expect(calls).toBe(2);
    expect(requests[1]!.state.source_window).not.toEqual(requests[0]!.state.source_window);
    const disallowed = new ConstructRanker(undefined,{allowExternal:()=>false,isCurrent:()=>true});
    expect(await disallowed.rank(office)).toMatchObject({state:'ranking_disallowed'});
    const noProvider = new ConstructRanker(undefined,{allowExternal:()=>true,isCurrent:()=>true});
    expect(await noProvider.rank(office)).toMatchObject({state:'ranking_unavailable',reason:'no_provider'});
    const stale = new ConstructRanker(undefined,{allowExternal:()=>true,isCurrent:()=>false});
    expect(await stale.rank(office)).toMatchObject({state:'stale'});
  });

  it('bounds pre-redaction bytes, source lines and optional author text', () => {
    const source = `page / title="${'x'.repeat(1010)}"\n stock_rows Supply\n  text row.name,row.quantity,row.available\n`;
    const hash = createHash('sha256').update(source).digest('hex'), start = source.indexOf('stock_rows');
    expect(captureConstructEvidence(source,hash,{start,end:start+10},'stock_rows',OFFICE_COLUMN_INTENT)).toBeNull();
    for(const text of ['',' ', 'x'.repeat(241), 'columns\nsecret', 'columns\u0000secret']) expect(validAuthorIntent(text)).toBe(false);
    expect(validAuthorIntent('x'.repeat(240))).toBe(true);
    const longSuite='page /\n stock_rows Supply\n  text row.name,row.quantity,row.available\n  text row.name\n  text row.quantity\n  text row.available\n';
    const beginning=longSuite.indexOf('stock_rows');
    const evidence=captureConstructEvidence(longSuite,createHash('sha256').update(longSuite).digest('hex'),
      {start:beginning,end:beginning+10},'stock_rows',OFFICE_COLUMN_INTENT)!;
    expect(evidence.sourceWindow.logicalLines).toBe(5);expect(evidence.sourceWindow.truncated).toBe(true);
  });
  it('withholds ranking when blank lines hide an omitted collection child', async () => {
    const visible = 'page /\n stock_rows Supply\n  text row.name,row.quantity,row.available\n  text row.name\n  text row.quantity';
    const source = `${visible}\n\n   \n  text "omitted private child"\n`;
    const hash = createHash('sha256').update(source).digest('hex'), start = source.indexOf('stock_rows');
    const evidence = captureConstructEvidence(source, hash, { start, end: start + 10 }, 'stock_rows', OFFICE_COLUMN_INTENT)!;
    expect(evidence.sourceWindow.logicalLines).toBe(5);
    expect(evidence.sourceWindow.truncated).toBe(true);
    expect(evidence.sourceWindow.text).not.toContain('omitted');
    expect(evidence.sourceWindow.bytesBeforeRedaction).toBe(Buffer.byteLength(visible));
    let calls = 0;
    const ranker = new ConstructRanker({ choose: async () => { calls++; throw new Error('incomplete statement reached provider'); } },
      { allowExternal: () => true, isCurrent: () => true });
    expect(await ranker.rank({ ...occurrence, sourceHash: hash, span: { start, end: start + 10 },
      messageKind: 'unknown_collection_presentation', slot: 'then.collection-presentation', guess: 'stock_rows',
      materialIntentChoice: true, evidenceSufficient: false, evidence,
      cards: cards.map((card, index) => ({ ...card, id: index === 0 ? 'can.v1.ui.list' : 'can.v1.ui.table' })) }))
      .toMatchObject({ state: 'intent_required' });
    expect(calls).toBe(0);
    const ended = `${visible}\n\n page /next\n`;
    const complete = captureConstructEvidence(ended, createHash('sha256').update(ended).digest('hex'),
      { start, end: start + 10 }, 'stock_rows', OFFICE_COLUMN_INTENT)!;
    expect(complete.sourceWindow.truncated).toBe(false);
  });

  it('withholds ranking when comment-only lines hide an omitted collection child', async () => {
    const visible = 'page /\n stock_rows Supply\n  text row.name,row.quantity,row.available\n  text row.name\n  text row.quantity';
    const source = `${visible}\n ## omitted private comment\n\n  text "omitted private child"\n`;
    const hash = createHash('sha256').update(source).digest('hex'), start = source.indexOf('stock_rows');
    const evidence = captureConstructEvidence(source, hash, { start, end: start + 10 }, 'stock_rows', OFFICE_COLUMN_INTENT)!;
    expect(evidence.sourceWindow.truncated).toBe(true);
    expect(evidence.sourceWindow.text).not.toContain('omitted');
    expect(evidence.sourceWindow.bytesBeforeRedaction).toBe(Buffer.byteLength(visible));
    let calls = 0;
    const ranker = new ConstructRanker({ choose: async () => { calls++; throw new Error('incomplete statement reached provider'); } },
      { allowExternal: () => true, isCurrent: () => true });
    expect(await ranker.rank({ ...occurrence, sourceHash: hash, span: { start, end: start + 10 },
      messageKind: 'unknown_collection_presentation', slot: 'then.collection-presentation', guess: 'stock_rows',
      materialIntentChoice: true, evidenceSufficient: false, evidence,
      cards: cards.map((card, index) => ({ ...card, id: index === 0 ? 'can.v1.ui.list' : 'can.v1.ui.table' })) }))
      .toMatchObject({ state: 'intent_required' });
    expect(calls).toBe(0);
    for (const next of [' page /next', ' text "## literal"', ' text row.name ## inline comment']) {
      const ended = `${visible}\n ## private comment\n${next}\n`;
      expect(captureConstructEvidence(ended, createHash('sha256').update(ended).digest('hex'),
        { start, end: start + 10 }, 'stock_rows', OFFICE_COLUMN_INTENT)!.sourceWindow.truncated).toBe(false);
    }
  });

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
    expect(await ranker.rank({ ...occurrence, cards: [cards[0]!], evidenceSufficient: false }))
      .toMatchObject({ state: "deterministic", card: cards[0] });
    expect(await ranker.rank({ ...occurrence, cards: [cards[0]!], evidenceSufficient: false, materialIntentChoice: true }))
      .toMatchObject({ state: "intent_required" });
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
