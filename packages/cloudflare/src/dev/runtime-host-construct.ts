/** Captured semantic facts only; revision/currentness and retention belong to Rust. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ConstructRanker } from "./jev-ranker.js";
import { captureConstructEvidence } from "./construct-evidence.js";
import { FIRST_PROFILE, parseCompilerConstructCandidates, type QualifiedConstructProof, loadConstructHelpIndex, createConstructHelpIndex, joinCompilerConstructCandidates,
  type CatalogFact, type ConstructHelpIndex, type ConstructHelpInputs } from "./construct-help.js";
import { installedReferenceRoot } from "./preview-inputs.js";
import type { SingleFileCapture } from "./source-capture.js";
import type { SessionConstructQualification } from "./session-service.js";
import { readRuntimeFile, runtimeObject, runtimeString } from "./runtime-host-protocol.js";
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function capturedInput(capture: SingleFileCapture, path: string, producer?: RegExp): { sha256: string; canonicalPath: string } {
  const matches = capture.inputs.filter(input => (input.canonicalPath === resolve(capture.root, path) ||
    producer?.test(input.name) === true) &&
    input.state === "present" && typeof input.sha256 === "string");
  const selected = matches.length === 1 ? matches[0] : undefined;
  if (selected === undefined || typeof selected.sha256 !== "string" || selected.canonicalPath === null) {
    throw new Error(`construct help input is absent: ${path}`);
  }
  return { sha256: selected.sha256, canonicalPath: selected.canonicalPath };
}

async function capturedCatalog(capture: SingleFileCapture, path: string, exportName: string,
  producer?: RegExp): Promise<readonly CatalogFact[]> {
  const input = capturedInput(capture, path, producer);
  const hash = async (): Promise<string> => createHash("sha256").update(await readFile(input.canonicalPath)).digest("hex");
  if (await hash() !== input.sha256) throw new Error(`construct help catalog changed after capture: ${path}`);
  const module = await import(`${pathToFileURL(input.canonicalPath).href}?can-dev=${input.sha256}`) as Record<string, unknown>;
  if (await hash() !== input.sha256) throw new Error(`construct help catalog changed during load: ${path}`);
  const entries = record(module[exportName])?.entries;
  if (!Array.isArray(entries)) throw new Error(`construct help catalog export is missing: ${exportName}`);
  return entries as readonly CatalogFact[];
}

export async function capturedHelpIndex(capture: SingleFileCapture): Promise<{ index: ConstructHelpIndex; inputs: ConstructHelpInputs }> {
  const compiler = capture.inputs.find(input => input.name === "compiler" && input.state === "present");
  const help = capture.inputs.find(input => input.name === "help-index" && input.state === "present");
  if (!compiler?.sha256 || !help?.sha256) throw new Error("construct help compiler or document input is missing");
  const grammar = capturedInput(capture, "docs/specification/GRAMMAR.md", /^extra:grammar$/);
  const values = capturedInput(capture, "packages/values/src/catalog.ts",
    /^extra:source:@canlang\/values@[^/]+\/src\/catalog\.ts$/);
  const ui = capturedInput(capture, "packages/ui/src/catalog.ts",
    /^extra:source:@canlang\/ui@[^/]+\/src\/catalog\.ts$/);
  const [valuesEntries, uiEntries] = await Promise.all([
    capturedCatalog(capture, "packages/values/dist/src/catalog.js", "CATALOG",
      /^package:@canlang\/values@[^/]+\/dist\/src\/catalog\.js$/),
    capturedCatalog(capture, "packages/ui/dist/src/catalog.js", "UI_CATALOG",
      /^package:@canlang\/ui@[^/]+\/dist\/src\/catalog\.js$/),
  ]);
  const profileGuards = ['compiler-check','preview-builder'].map(name => capture.inputs.filter(input =>
    new RegExp(`^package:@canlang/cloudflare@[^/]+/dist/dev/${name}\\.js$`).test(input.name) &&
    input.state === 'present' && typeof input.sha256 === 'string'));
  const profilePolicy = profileGuards.every(inputs => inputs.length === 1)
    ? { sha256: createHash('sha256').update(JSON.stringify(profileGuards.map(inputs => inputs[0]!.sha256))).digest('hex') }
    : undefined;
  const inputs = {
    languageVersion: "1.0", compiler: { sha256: compiler.sha256 }, grammar: { sha256: grammar.sha256 },
    values: { sha256: values.sha256, entries: valuesEntries },
    ui: { sha256: ui.sha256, entries: uiEntries },
    ...(profilePolicy === undefined ? {} : { profilePolicy }),
  };
  const referenceRoot = installedReferenceRoot(capture.root);
  const index = await loadConstructHelpIndex(referenceRoot, inputs, help.sha256);
  const markdown = await readFile(join(referenceRoot, "docs/specification/CONSTRUCT-HELP.md"), "utf8");
  if (createHash("sha256").update(markdown).digest("hex") !== help.sha256) throw new Error("captured help changed during snapshot");
  return { index, inputs: { ...inputs, markdown } };
}

export async function runtimeConstruct(capture: SingleFileCapture, payload: Record<string, unknown>) {
  const saved = payload.index === undefined ? await capturedHelpIndex(capture)
    : runtimeObject(JSON.parse((await readRuntimeFile(payload.index)).toString("utf8")));
  const inputs = runtimeObject(saved.inputs) as unknown as ConstructHelpInputs;
  const index = createConstructHelpIndex(inputs);
  if (index.compilerSha256 !== capture.inputs.find(input => input.name === "compiler")?.sha256 ||
      index.documentSha256 !== capture.inputs.find(input => input.name === "help-index")?.sha256) {
    throw new Error("captured help identity mismatch");
  }
  const qualification = payload.qualification === undefined ? null
    : JSON.parse((await readRuntimeFile(payload.qualification)).toString("utf8")) as SessionConstructQualification | null;
  const proofs = qualification?.indexRevision === index.revision && qualification.compilerSha256 === index.compilerSha256
    && qualification.authoringProfile === FIRST_PROFILE && qualification.resourceProfile === capture.profile
    && qualification.producerInputsDigest === createHash("sha256").update(JSON.stringify(capture.inputs)).digest("hex")
    ? qualification.proofs : [];
  const producerInputsDigest = createHash("sha256").update(JSON.stringify(capture.inputs)).digest("hex");
  const request = { resourceProfile: capture.profile, authoringProfile: FIRST_PROFILE, indexRevision: index.revision,
    compilerSha256: index.compilerSha256, producerInputsDigest, inputs: capture.inputs };
  const base = { index_revision: index.revision, compiler_sha256: index.compilerSha256, authoring_profile: FIRST_PROFILE,
    producer_inputs_digest: producerInputsDigest, request };
  switch (payload.action) {
    case "index": return { ...base, inputs, cards: index.cards };
    case "help": {
      const id = runtimeString(payload.id);
      const card = index.get(id, FIRST_PROFILE, proofs.find(proof => proof.id === id));
      if (card === undefined) throw new Error("construct ID unavailable");
      return { ...base, card, unqualified_card: index.get(id) };
    }
    case "detail": return { ...base, construct_help: joinCompilerConstructCandidates(index, payload.candidates, FIRST_PROFILE, proofs),
      unqualified_construct_help: joinCompilerConstructCandidates(index, payload.candidates, FIRST_PROFILE) };
    case "rank": return { ...base, result: await rankConstruct(capture, payload, index, qualification, proofs) };
    default: throw new Error("unknown construct action");
  }
}

function sourceKeywordAt(bytes: Buffer, start: number): boolean {
  let quote = 0;
  let comment = false;
  for (let offset = 0; offset < start; offset++) {
    const byte = bytes[offset]!;
    if (comment) { if (byte === 10 || byte === 13) comment = false; continue; }
    if (quote !== 0) {
      if (byte === 92) { offset++; continue; }
      if (byte === quote) quote = 0;
      continue;
    }
    if (byte === 35) comment = true;
    else if (byte === 34 || byte === 39 || byte === 96) quote = byte;
  }
  return quote === 0 && !comment;
}

async function rankConstruct(capture: SingleFileCapture, payload: Record<string, unknown>, index: ConstructHelpIndex,
  bundle: SessionConstructQualification | null, proofs: readonly QualifiedConstructProof[]) {
  const diagnostic = runtimeObject(payload.diagnostic);
  const routing = parseCompilerConstructCandidates(diagnostic.construct_candidates);
  if (routing.disposition === "structural") return { state: "structural", reason: "authoring slot is not reliable" };
  if (routing.disposition === "none" && routing.complete && payload.complete === true && payload.omitted === 0) return { state: "none" };
  if (routing.disposition !== "exact" || !routing.complete || routing.context === undefined) {
    return { state: "candidate_coverage_unknown", reason: "captured compiler ranking context is incomplete" };
  }
  const context = routing.context, span = runtimeObject(diagnostic.primary);
  const start = Number(span.start), end = Number(span.end), bytes = Buffer.from(capture.sourceText, "utf8");
  const exactSourceSpan = exactRankingSpan(context, bytes, start, end);
  if (!context.recoveryComplete || !context.nameFilterComplete || !exactSourceSpan) return { state: "ineligible", reason: "diagnostic or source capture is incomplete" };
  if (proofs.length === 0 || !bundle?.messageKinds.includes(context.messageKind)) return { state: "candidate_coverage_unknown", reason: "host profile or diagnostic branch qualification is unavailable" };
  const selected = joinCompilerConstructCandidates(index, routing, FIRST_PROFILE, proofs);
  const evidence = context.messageKind === "unknown_collection_presentation"
    ? captureConstructEvidence(capture.sourceText, capture.sourceSha256, { start, end }, context.guess,
      typeof payload.authorIntent === "string" ? payload.authorIntent : undefined) : null;
  const ranker = new ConstructRanker(undefined, { allowExternal: () => false, isCurrent: () => true });
  try {
    return await ranker.rank({ ref: "semantic", revision: "semantic", helpRevision: index.revision,
      diagnosticCode: runtimeString(diagnostic.code), sourceHash: capture.sourceSha256, span: { start, end },
      messageKind: context.messageKind, section: context.section, slot: routing.slot, guess: context.guess,
      complete: payload.complete === true, omitted: Number(payload.omitted), exactSourceSpan,
      structuralRecovery: context.structuralRecovery, candidateCoverage: selected.candidateCoverage,
      unsupportedBehaviorProven: context.unsupportedBehaviorProven, materialIntentChoice: context.materialIntentChoice,
      ...(evidence === null ? {} : { evidence }), evidenceSufficient: context.evidenceSufficient,
      cards: selected.cards.map(card => ({ id: card.id, section: card.section, signature: card.signature, meaning: card.meaning, availability: card.status })) });
  } finally { ranker.close(); }
}

function exactRankingSpan(context: { exactSourceSpan: boolean; guess: string }, bytes: Buffer, start: number, end: number): boolean {
  return context.exactSourceSpan && Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    start >= 0 && end >= start && end <= bytes.length && sourceKeywordAt(bytes, start) &&
    bytes.subarray(start, end).equals(Buffer.from(context.guess, "utf8")) &&
    (start === 0 || !/[A-Za-z0-9_]/.test(String.fromCharCode(bytes[start - 1]!))) &&
    (end === bytes.length || !/[A-Za-z0-9_]/.test(String.fromCharCode(bytes[end]!)));
}
