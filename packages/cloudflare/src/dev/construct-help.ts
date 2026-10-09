/**
 * Revisioned, immutable view of the single authored Can construct catalog.
 *
 * The Markdown document owns author-facing prose. This adapter rejects broken
 * cards and catalog drift, then serves cards from captured bytes. It does not
 * infer compiler slots or turn a renderer/catalog entry into a working Can
 * construct. The compiler must supply complete, context-specific candidates;
 * producer checks must qualify each candidate for the selected profile.
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const CARD_ID = /^can\.v1\.[a-z0-9_.-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DOCUMENT_PATH = "docs/specification/CONSTRUCT-HELP.md";
const VALUES_SOURCE = "packages/values/src/catalog.ts";
const UI_SOURCE = "packages/ui/src/catalog.ts";
export const FIRST_PROFILE = "office-supplies-local-v1";

/** Finite authoring surface for the first supported app. A card still needs evidence. */
const FIRST_PROFILE_IDS = new Set([
  "can.v1.app.implicit", "can.v1.section.given", "can.v1.section.when", "can.v1.section.then",
  "can.v1.model", "can.v1.schema", "can.v1.field", "can.v1.field.default",
  "can.v1.field.trim", "can.v1.field.min", "can.v1.field.max", "can.v1.type.nullable",
  "can.v1.type.enum", "can.v1.type.builtin.text", "can.v1.type.builtin.int",
  "can.v1.type.builtin.bool", "can.v1.policy", "can.v1.invariant", "can.v1.lock",
  "can.v1.derive.function", "can.v1.fixture.model", "can.v1.fixture.user",
  "can.v1.when.crud", "can.v1.when.scenario.user", "can.v1.when.scenario.read",
  "can.v1.examples.table.crud", "can.v1.examples.table.scenario", "can.v1.examples.table.error",
  "can.v1.then.preferences-schema", "can.v1.then.page", "can.v1.then.form",
  "can.v1.then.edit", "can.v1.then.delete", "can.v1.then.text",
  "can.v1.ui.card", "can.v1.ui.input", "can.v1.ui.tabs-selector",
  "can.v1.ui.list", "can.v1.ui.table", "can.v1.ui.stat", "can.v1.builtin.count",
]);

export function firstProfileConstructIds(): readonly string[] {
  return Object.freeze([...FIRST_PROFILE_IDS].sort());
}

export interface CatalogFact {
  readonly id: string;
  readonly kind?: string;
  readonly signature?: string;
  readonly availability?: string;
}

export interface SourceFact {
  /** Exact-byte SHA-256 of the owning input, captured with the app check. */
  readonly sha256: string;
  readonly entries?: readonly CatalogFact[];
}

export interface ConstructHelpInputs {
  /** Exact captured UTF-8 bytes; never reread live disk for historical help. */
  readonly markdown: string;
  readonly languageVersion: string;
  readonly compiler: SourceFact;
  readonly grammar: SourceFact;
  readonly values: SourceFact;
  readonly ui: SourceFact;
}

export type HelpAvailability = "working" | "unavailable" | "planned";

export interface ConstructHelpCard {
  readonly id: string;
  readonly section: string;
  readonly signature: string;
  readonly meaning: string;
  /** Minimal explanatory fragment, not a claimed whole-app pass. */
  readonly example: string;
  readonly availability: string;
  readonly status: HelpAvailability;
  readonly link: string;
  /** Owning grammar or catalog location; distinct from the stable card link. */
  readonly sourceLink: string;
}

export interface QualifiedConstructProof {
  readonly id: string;
  readonly indexRevision: string;
  readonly profile: string;
  readonly compilerSha256: string;
  /** A passing source-current compiler example in the exact grammar slot. */
  readonly compilerCheck: string | null;
  /** A passing source-current consumer case in the selected runtime profile. */
  readonly runtimeCheck: string | null;
  /** Required for executable-example cards. */
  readonly exampleCheck?: string | null;
}

export interface CandidateInventory {
  readonly slot: string;
  readonly profile: string;
  readonly compilerSha256: string;
  readonly indexRevision: string;
  /** Compiler-derived finite IDs for the exact parser/semantic position. */
  readonly ids: readonly string[];
  /** True only if parser recovery/name filtering did not lose coverage. */
  readonly complete: boolean;
}

export interface QualifiedCandidateSet {
  readonly candidateCoverage: "complete" | "unknown";
  readonly reason?: string;
  readonly cards: readonly ConstructHelpCard[];
}

/** The compiler's optional diagnostic routing extension, normalized at the JSON boundary. */
export interface CompilerConstructCandidates {
  readonly version: 1;
  readonly disposition: "exact" | "structural" | "none" | "unknown";
  readonly slot: string | null;
  readonly ids: readonly string[];
  readonly complete: boolean;
}

export interface RoutedConstructHelp extends QualifiedCandidateSet {
  readonly disposition: CompilerConstructCandidates["disposition"];
  readonly slot: string | null;
}

const UNKNOWN_ROUTING: CompilerConstructCandidates = Object.freeze({
  version: 1, disposition: "unknown", slot: null, ids: Object.freeze([]), complete: false,
});

/** Reject malformed or overbroad routing as unknown; never recover IDs from prose. */
export function parseCompilerConstructCandidates(value: unknown): CompilerConstructCandidates {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return UNKNOWN_ROUTING;
  const entry = value as Record<string, unknown>;
  if (entry["version"] !== 1 || typeof entry["disposition"] !== "string" ||
      !["exact", "structural", "none", "unknown"].includes(entry["disposition"]) ||
      typeof entry["complete"] !== "boolean" || !Array.isArray(entry["ids"])) return UNKNOWN_ROUTING;
  const disposition = entry["disposition"] as CompilerConstructCandidates["disposition"];
  const slot = entry["slot"] === undefined ? null : entry["slot"];
  if (slot !== null && (typeof slot !== "string" || !/^[a-z][a-z0-9_.-]{0,95}$/.test(slot))) return UNKNOWN_ROUTING;
  const ids = entry["ids"] as unknown[];
  if (ids.length > 8 || ids.some(id => typeof id !== "string" || id.length > 96 || !CARD_ID.test(id)) ||
      new Set(ids).size !== ids.length) return UNKNOWN_ROUTING;
  if (disposition === "exact" && (slot === null || ids.length === 0)) return UNKNOWN_ROUTING;
  if (disposition !== "exact" && ids.length !== 0) return UNKNOWN_ROUTING;
  if ((disposition === "structural" || disposition === "unknown") && entry["complete"] !== false) return UNKNOWN_ROUTING;
  return Object.freeze({ version: 1, disposition, slot: slot as string | null,
    ids: Object.freeze(ids as string[]), complete: entry["complete"] as boolean });
}

/** Join exact compiler IDs to captured cards; only source-current proofs may qualify them. */
export function joinCompilerConstructCandidates(
  index: ConstructHelpIndex,
  value: unknown,
  profile: string,
  proofs: readonly QualifiedConstructProof[] = [],
): RoutedConstructHelp {
  const routing = parseCompilerConstructCandidates(value);
  if (routing.disposition === "none" && routing.complete) {
    return { disposition: "none", slot: routing.slot, candidateCoverage: "complete", cards: [] };
  }
  if (routing.disposition !== "exact") {
    return { disposition: routing.disposition, slot: routing.slot, candidateCoverage: "unknown",
      reason: routing.disposition === "structural" ? "structural recovery needs a source edit" : "compiler candidate routing is incomplete",
      cards: [] };
  }
  const selected = index.candidates({ slot: routing.slot!, profile,
    compilerSha256: index.compilerSha256, indexRevision: index.revision,
    ids: routing.ids, complete: routing.complete }, proofs);
  return { disposition: "exact", slot: routing.slot, ...selected };
}

export interface ConstructHelpIndex {
  readonly revision: string;
  readonly languageVersion: string;
  readonly documentSha256: string;
  readonly compilerSha256: string;
  readonly cards: readonly ConstructHelpCard[];
  get(id: string): ConstructHelpCard | undefined;
  candidates(inventory: CandidateInventory | null, proofs?: readonly QualifiedConstructProof[]): QualifiedCandidateSet;
  exactType(word: string, profile: string, proof?: QualifiedConstructProof): ConstructHelpCard | undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(size).update(bytes);
  }
  return hash.digest("hex");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#124;/g, "|")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function splitRow(line: string): string[] {
  if (!line.startsWith("| ") || !line.endsWith(" |")) throw new Error("invalid construct help row");
  const cells: string[] = [];
  let cell = "";
  for (let i = 1; i < line.length - 1; i += 1) {
    const char = line[i];
    if (char === "|" && line[i - 1] !== "\\") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function plainCode(value: string): string {
  const code = value.match(/^<code>([\s\S]*)<\/code>$/);
  const source = code ? code[1]! : value.match(/^`([\s\S]*)`$/)?.[1];
  if (source === undefined) throw new Error("construct help example is not a code fragment");
  return decodeEntities(source.replace(/<br\s*\/?\s*>/gi, "\n"));
}

function inlineCode(value: string, field: string): string {
  const content = value.match(/^`([\s\S]*)`$/)?.[1];
  if (!content) throw new Error(`construct help ${field} is missing`);
  return decodeEntities(content.replace(/\\\|/g, "|"));
}

function linkTarget(value: string, field: string): string {
  const target = value.match(/^\[[^\]]+\]\(([^)]+)\)$/)?.[1];
  if (!target) throw new Error(`construct help ${field} is missing`);
  return target;
}

function sectionFromHeading(heading: string): string {
  if (heading === "Callable builtins") return "Expression";
  if (heading.startsWith("App,")) return "App/Given";
  if (heading.startsWith("When,")) return "When";
  if (heading.startsWith("Then,")) return "Then";
  throw new Error(`unknown construct help section: ${heading}`);
}

function cardSection(id: string, tableSection: string): string {
  if (id.startsWith("can.v1.app.") || id === "can.v1.package" || id.startsWith("can.v1.import") ||
      id.startsWith("can.v1.context") || id === "can.v1.export") return "App";
  if (id === "can.v1.section.when" || id.startsWith("can.v1.when.") || id.startsWith("can.v1.execution.") ||
      id.startsWith("can.v1.examples.")) return "When";
  if (id === "can.v1.section.then" || id.startsWith("can.v1.then.") || id.startsWith("can.v1.ui.")) return "Then";
  if (id.startsWith("can.v1.expression.") || id.startsWith("can.v1.builtin.")) return "Expression";
  if (id.startsWith("can.v1.maintenance.")) return "Migration";
  return tableSection === "App/Given" ? "Given" : tableSection;
}

function parseCards(markdown: string): ConstructHelpCard[] {
  const cards: ConstructHelpCard[] = [];
  const ids = new Set<string>();
  let section = "";
  let tableWidth = 0;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("### ")) section = sectionFromHeading(line.slice(4));
    if (line === "| ID | Signature | Meaning | Example | Availability | Source | Stable link |") {
      tableWidth = 7;
      continue;
    }
    if (line === "| ID | Signature | Meaning | Example | Availability | Stable link |") {
      tableWidth = 6;
      continue;
    }
    if (!line.startsWith("| <a id=")) continue;
    if (!section || !tableWidth) throw new Error("construct card is outside a known table");
    const cells = splitRow(line);
    if (cells.length !== tableWidth) throw new Error(`construct help row has ${cells.length} cells; expected ${tableWidth}`);
    const header = cells[0]?.match(/^<a id="(can-v1-[a-z0-9_-]+)"><\/a>`(can\.v1\.[a-z0-9_.-]+)`$/);
    if (!header) throw new Error("construct card has an invalid ID or anchor");
    const [, anchor, id] = header;
    const normalAnchor = id?.replace(/\./g, "-");
    if (!id || !anchor || !CARD_ID.test(id) ||
        (anchor !== normalAnchor && anchor !== normalAnchor?.replace(/_/g, "-"))) {
      throw new Error(`construct card ID/anchor mismatch: ${id ?? "unknown"}`);
    }
    if (ids.has(id)) throw new Error(`duplicate construct card: ${id}`);
    ids.add(id);
    const signature = inlineCode(cells[1]!, "signature");
    const meaning = cells[2]?.trim() ?? "";
    const example = plainCode(cells[3]!);
    const availability = cells[4]?.trim() ?? "";
    const link = linkTarget(cells[tableWidth - 1]!, "stable link");
    if (!meaning || !availability || !example || link !== `#${anchor}`) {
      throw new Error(`incomplete construct card: ${id}`);
    }
    const sourceLink = tableWidth === 7
      ? linkTarget(cells[5]!, "source link")
      : VALUES_SOURCE;
    cards.push(Object.freeze({
      id,
      section: cardSection(id, section),
      signature,
      meaning,
      example,
      availability,
      status: availability.toLowerCase().includes("proposed") ? "planned" : "unavailable",
      link: `${DOCUMENT_PATH}${link}`,
      sourceLink,
    }));
  }
  if (cards.length === 0) throw new Error("construct help inventory is empty");
  return cards;
}

function validateCatalogFacts(cards: readonly ConstructHelpCard[], input: ConstructHelpInputs): void {
  const builtinCards = cards.filter(card => card.id.startsWith("can.v1.builtin."));
  const builtinFacts = input.values.entries?.filter(entry => entry.kind === "builtin");
  if (!builtinFacts) throw new Error("captured Values catalog facts are required");
  const facts = new Map(builtinFacts.map(entry => [entry.id, entry]));
  if (facts.size !== builtinFacts.length || facts.size !== builtinCards.length) {
    throw new Error("Values builtin card inventory differs from captured catalog");
  }
  for (const card of builtinCards) {
    const name = card.id.slice("can.v1.builtin.".length);
    const fact = facts.get(name);
    if (!fact || fact.signature !== card.signature) {
      throw new Error(`Values builtin signature drift: ${card.id}`);
    }
  }
  const uiFacts = input.ui.entries;
  if (!uiFacts) throw new Error("captured UI catalog facts are required");
  const availableUi = new Set(uiFacts.filter(entry => entry.kind === "component").map(entry => entry.id));
  for (const card of cards.filter(card => card.id.startsWith("can.v1.ui."))) {
    const suffix = card.id.slice("can.v1.ui.".length);
    const name = suffix.startsWith("calendar-") ? "calendar"
      : suffix.startsWith("tabs-") ? "tabs"
      : suffix;
    if (!availableUi.has(name)) throw new Error(`UI construct missing from captured catalog: ${card.id}`);
  }
}

function applyCatalogAvailability(cards: readonly ConstructHelpCard[], input: ConstructHelpInputs): ConstructHelpCard[] {
  const values = new Map(input.values.entries!.map(entry => [entry.id, entry]));
  const ui = new Map(input.ui.entries!.map(entry => [entry.id, entry]));
  return cards.map(card => {
    if (card.status === "planned") return card;
    let fact: CatalogFact | undefined;
    if (card.id.startsWith("can.v1.builtin.")) {
      fact = values.get(card.id.slice("can.v1.builtin.".length));
    } else if (card.id.startsWith("can.v1.ui.")) {
      const suffix = card.id.slice("can.v1.ui.".length);
      const name = suffix.startsWith("calendar-") ? "calendar"
        : suffix.startsWith("tabs-") ? "tabs" : suffix;
      fact = ui.get(name);
    }
    return fact && fact.availability !== "implemented" && fact.availability !== "external"
      ? Object.freeze({ ...card, status: "planned" as const }) : card;
  });
}

function qualified(card: ConstructHelpCard, proof: QualifiedConstructProof | undefined, revision: string, profile: string, compilerSha256: string): boolean {
  return profile === FIRST_PROFILE && FIRST_PROFILE_IDS.has(card.id) && card.status !== "planned" &&
    proof?.id === card.id && proof.indexRevision === revision && proof.profile === profile &&
    proof.compilerSha256 === compilerSha256 && !!proof.compilerCheck && !!proof.runtimeCheck &&
    (!card.id.startsWith("can.v1.examples.") || !!proof.exampleCheck);
}

export function createConstructHelpIndex(input: ConstructHelpInputs): ConstructHelpIndex {
  for (const [name, fact] of Object.entries({
    compiler: input.compiler, grammar: input.grammar, values: input.values, ui: input.ui,
  })) {
    if (!SHA256.test(fact.sha256)) throw new Error(`missing captured ${name} source hash`);
  }
  if (input.languageVersion !== "1.0") throw new Error(`unsupported help language version: ${input.languageVersion}`);
  const authoredCards = parseCards(input.markdown);
  validateCatalogFacts(authoredCards, input);
  const cards = Object.freeze(applyCatalogAvailability(authoredCards, input));
  const byId = new Map(cards.map(card => [card.id, card]));
  for (const id of FIRST_PROFILE_IDS) {
    if (!byId.has(id)) throw new Error(`first-profile construct is absent from help: ${id}`);
  }
  const documentSha256 = sha256(input.markdown);
  const revision = digest([
    "can.dev.construct-help.v1", input.languageVersion, documentSha256,
    input.compiler.sha256, input.grammar.sha256, input.values.sha256, input.ui.sha256,
  ]);
  return Object.freeze({
    revision,
    languageVersion: input.languageVersion,
    documentSha256,
    compilerSha256: input.compiler.sha256,
    cards,
    get(id: string): ConstructHelpCard | undefined { return byId.get(id); },
    candidates(inventory: CandidateInventory | null, proofs: readonly QualifiedConstructProof[] = []): QualifiedCandidateSet {
      if (!inventory || !inventory.slot || !inventory.complete || inventory.indexRevision !== revision ||
          inventory.compilerSha256 !== input.compiler.sha256 || !inventory.profile) {
        return { candidateCoverage: "unknown", reason: "compiler slot inventory is incomplete or from another revision", cards: [] };
      }
      if (inventory.ids.length > 8 || new Set(inventory.ids).size !== inventory.ids.length) {
        return { candidateCoverage: "unknown", reason: "candidate inventory is broad or duplicated", cards: [] };
      }
      const proofById = new Map(proofs.map(proof => [proof.id, proof]));
      const selected: ConstructHelpCard[] = [];
      for (const id of inventory.ids) {
        const card = byId.get(id);
        if (!card) return { candidateCoverage: "unknown", reason: `unknown construct ID: ${id}`, cards: [] };
        selected.push(qualified(card, proofById.get(id), revision, inventory.profile, input.compiler.sha256)
          ? Object.freeze({ ...card, status: "working" as const }) : card);
      }
      if (selected.some(card => card.status !== "working")) {
        return { candidateCoverage: "unknown", reason: "one or more candidates lack exact profile qualification", cards: selected };
      }
      return { candidateCoverage: "complete", cards: selected };
    },
    exactType(word: string, profile: string, proof?: QualifiedConstructProof): ConstructHelpCard | undefined {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(word)) return undefined;
      const id = `can.v1.type.builtin.${word.toLowerCase()}`;
      const card = byId.get(id);
      if (!card || card.signature !== word.toLowerCase()) return undefined;
      return qualified(card, proof, revision, profile, input.compiler.sha256)
        ? Object.freeze({ ...card, status: "working" as const }) : card;
    },
  });
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const explicit = line.match(/<a id="([a-z0-9_-]+)"><\/a>/);
    if (explicit) anchors.add(explicit[1]!);
    const heading = line.match(/^#{1,6} (.+)$/)?.[1];
    if (!heading) continue;
    const slug = heading.toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/[`*]/g, "")
      .replace(/[^\p{L}\p{N}_ -]/gu, "")
      .trim().replace(/ +/g, "-");
    if (slug) anchors.add(slug);
  }
  return anchors;
}

/** Read one current, source-linked snapshot; retain the returned index for old revision lookups. */
export async function loadConstructHelpIndex(
  checkoutRoot: string,
  input: Omit<ConstructHelpInputs, "markdown">,
  expectedDocumentSha256: string,
): Promise<ConstructHelpIndex> {
  if (!SHA256.test(expectedDocumentSha256)) throw new Error("captured help hash is missing");
  const root = await realpath(checkoutRoot);
  const document = resolve(root, DOCUMENT_PATH);
  const actual = await realpath(document);
  if (!inside(root, actual)) throw new Error("construct help document escapes checkout");
  const markdown = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(actual));
  if (sha256(markdown) !== expectedDocumentSha256) throw new Error("construct help changed after capture");
  const index = createConstructHelpIndex({ ...input, markdown });
  const links = new Set(index.cards.map(card => card.sourceLink).filter(link => link !== VALUES_SOURCE));
  for (const link of links) {
    const [path, anchor] = link.split("#", 2);
    if (!path || !anchor) throw new Error(`construct help source link has no target: ${link}`);
    const linked = await realpath(resolve(dirname(actual), path));
    if (!inside(root, linked)) throw new Error(`construct help source link escapes checkout: ${link}`);
    const linkedText = await readFile(linked, "utf8");
    if (!headingAnchors(linkedText).has(anchor)) throw new Error(`construct help source anchor is missing: ${link}`);
  }
  return index;
}
