import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG } from "@canlang/values";
import { UI_CATALOG } from "@canlang/ui";
import {
  createConstructHelpIndex,
  joinCompilerConstructCandidates,
  loadConstructHelpIndex,
  parseCompilerConstructCandidates,
  type ConstructHelpInputs,
  type QualifiedConstructProof,
} from "../src/dev/construct-help.js";

const root = resolve(import.meta.dirname, "../../..");
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

async function inputs(): Promise<ConstructHelpInputs> {
  const [markdown, grammar, values, ui] = await Promise.all([
    readFile(resolve(root, "docs/specification/CONSTRUCT-HELP.md"), "utf8"),
    readFile(resolve(root, "docs/specification/GRAMMAR.md"), "utf8"),
    readFile(resolve(root, "packages/values/src/catalog.ts"), "utf8"),
    readFile(resolve(root, "packages/ui/src/catalog.ts"), "utf8"),
  ]);
  return {
    markdown,
    languageVersion: "1.0",
    compiler: { sha256: hash("captured compiler binary") },
    grammar: { sha256: hash(grammar) },
    values: { sha256: hash(values), entries: CATALOG.entries },
    ui: { sha256: hash(ui), entries: UI_CATALOG.entries },
  };
}

function proof(id: string, indexRevision: string, compilerSha256: string): QualifiedConstructProof {
  return {
    id,
    indexRevision,
    profile: "office-supplies-local-v1",
    compilerSha256,
    compilerCheck: "source-current-compiler-case",
    runtimeCheck: "source-current-local-consumer-case",
    exampleCheck: "source-current-executed-row",
  };
}

describe("captured construct help", () => {
  it("indexes every authored card once with stable links and source-backed builtin signatures", async () => {
    const source = await inputs();
    const index = await loadConstructHelpIndex(root, source, hash(source.markdown));
    expect(index.cards).toHaveLength(278);
    expect(new Set(index.cards.map(card => card.id)).size).toBe(index.cards.length);
    expect(index.documentSha256).toBe(hash(source.markdown));
    for (const card of index.cards) {
      expect(card.signature.length).toBeGreaterThan(0);
      expect(card.meaning.length).toBeGreaterThan(0);
      expect(card.example.length).toBeGreaterThan(0);
      expect(card.availability.length).toBeGreaterThan(0);
      expect(source.markdown).toContain(`<a id="${card.link.split("#")[1]}"></a>`);
    }
    expect(index.get("can.v1.policy")?.signature).toBe("policy path read=expr [where=expr] [fields=selectors]");
    expect(index.get("can.v1.policy")?.section).toBe("Given");
    expect(index.get("can.v1.when.crud")?.section).toBe("When");
    expect(index.get("can.v1.builtin.count")?.signature).toBe(CATALOG.entries.find(entry => entry.id === "count")?.signature);
    expect(index.get("can.v1.not-a-card")).toBeUndefined();
    await expect(loadConstructHelpIndex(root, source, hash("old help bytes"))).rejects.toThrow(/changed after capture/);
  });

  it("pins the card result to help and owner input revisions", async () => {
    const source = await inputs();
    const first = createConstructHelpIndex(source);
    expect(createConstructHelpIndex(source).revision).toBe(first.revision);
    expect(createConstructHelpIndex({ ...source, compiler: { ...source.compiler, sha256: hash("next compiler") } }).revision)
      .not.toBe(first.revision);
    expect(createConstructHelpIndex({ ...source, markdown: `${source.markdown}\n` }).revision)
      .not.toBe(first.revision);
    expect(() => createConstructHelpIndex({ ...source, markdown: source.markdown.replace("#can-v1-policy)", "#wrong-anchor)") }))
      .toThrow(/incomplete construct card/);
    const brokenValues = { ...source.values, entries: CATALOG.entries.filter(entry => entry.id !== "count") };
    expect(() => createConstructHelpIndex({ ...source, values: brokenValues })).toThrow(/Values builtin card inventory/);
  });

  it("never promotes an unproven or stale profile candidate", async () => {
    const index = createConstructHelpIndex(await inputs());
    const ids = ["can.v1.policy", "can.v1.invariant"];
    const inventory = {
      slot: "given.rule",
      profile: "office-supplies-local-v1",
      compilerSha256: index.compilerSha256,
      indexRevision: index.revision,
      ids,
      complete: true,
    };
    const unproven = index.candidates(inventory);
    expect(unproven.candidateCoverage).toBe("unknown");
    expect(unproven.cards.map(card => card.status)).toEqual(["unavailable", "unavailable"]);
    const proofs = ids.map(id => proof(id, index.revision, index.compilerSha256));
    expect(index.candidates(inventory, proofs).candidateCoverage).toBe("complete");
    expect(index.candidates({ ...inventory, indexRevision: hash("old") }, proofs).candidateCoverage).toBe("unknown");
    expect(index.candidates({ ...inventory, ids: [...ids, "can.v1.fake"] }, proofs).candidateCoverage).toBe("unknown");
    expect(index.candidates({ ...inventory, complete: false }, proofs).candidateCoverage).toBe("unknown");
    expect(index.candidates({ ...inventory, ids: ["can.v1.context.queue"] }, [proof("can.v1.context.queue", index.revision, index.compilerSha256)])
      .candidateCoverage).toBe("unknown");
  });

  it("only offers a deterministic type card for exact case spelling in a known type slot", async () => {
    const index = createConstructHelpIndex(await inputs());
    expect(index.exactType("Text", "office-supplies-local-v1")?.id).toBe("can.v1.type.builtin.text");
    expect(index.exactType("Number", "office-supplies-local-v1")).toBeUndefined();
    expect(index.exactType("rule", "office-supplies-local-v1")).toBeUndefined();
    expect(index.exactType("atomic", "office-supplies-local-v1")).toBeUndefined();
    expect(index.exactType("Text", "office-supplies-local-v1")?.status).toBe("unavailable");
    expect(index.exactType("Text", "office-supplies-local-v1", proof("can.v1.type.builtin.text", index.revision, index.compilerSha256))?.status)
      .toBe("working");
  });

  it("preserves structural and no-suggestion compiler routing", async () => {
    const index = createConstructHelpIndex(await inputs());
    const structural = { version: 1, disposition: "structural", ids: [], complete: false };
    expect(joinCompilerConstructCandidates(index, structural, "office-supplies-local-v1"))
      .toMatchObject({ disposition: "structural", candidateCoverage: "unknown", cards: [] });
    const none = { version: 1, disposition: "none", slot: "given.rule", ids: [], complete: true };
    expect(joinCompilerConstructCandidates(index, none, "office-supplies-local-v1"))
      .toMatchObject({ disposition: "none", candidateCoverage: "complete", cards: [] });
    expect(joinCompilerConstructCandidates(index, { ...none, complete: false }, "office-supplies-local-v1"))
      .toMatchObject({ disposition: "none", candidateCoverage: "unknown", cards: [] });
  });

  it("bounds and validates compiler IDs before joining captured proof-gated cards", async () => {
    const index = createConstructHelpIndex(await inputs());
    const exact = { version: 1, disposition: "exact", slot: "given.rule", ids: ["can.v1.policy"], complete: true };
    expect(joinCompilerConstructCandidates(index, exact, "office-supplies-local-v1"))
      .toMatchObject({ disposition: "exact", candidateCoverage: "unknown", cards: [{ id: "can.v1.policy", status: "unavailable" }] });
    expect(joinCompilerConstructCandidates(index, { ...exact, complete: false }, "office-supplies-local-v1"))
      .toMatchObject({ disposition: "exact", candidateCoverage: "unknown", cards: [] });
    expect(joinCompilerConstructCandidates(index, exact, "office-supplies-local-v1",
      [proof("can.v1.policy", index.revision, index.compilerSha256)]))
      .toMatchObject({ disposition: "exact", candidateCoverage: "complete", cards: [{ id: "can.v1.policy", status: "working" }] });
    expect(joinCompilerConstructCandidates(index, exact, "office-supplies-local-v1",
      [proof("can.v1.policy", hash("old"), index.compilerSha256)]).candidateCoverage).toBe("unknown");
    for (const bad of [
      null, { ...exact, version: 2 }, { ...exact, slot: "" }, { ...exact, ids: [] },
      { ...exact, ids: ["can.v1.policy", "can.v1.policy"] },
      { ...exact, ids: Array(9).fill("can.v1.policy") },
      { ...exact, ids: [`can.v1.${"x".repeat(100)}`] },
      { ...exact, disposition: "structural" }, { ...exact, disposition: "unknown" },
      { ...exact, disposition: "none" }, { ...exact, complete: "true" },
      { version: 1, disposition: "structural", ids: [], complete: true },
    ]) {
      expect(parseCompilerConstructCandidates(bad).disposition).toBe("unknown");
      expect(joinCompilerConstructCandidates(index, bad, "office-supplies-local-v1"))
        .toMatchObject({ disposition: "unknown", candidateCoverage: "unknown", cards: [] });
    }
  });
});
