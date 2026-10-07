/**
 * Localized internal reference renderer (D05a).
 *
 * Pure deterministic Markdown renderer consuming the frozen reference model
 * v1 (`@canlang/contracts` `ReferenceModel`). Description variants and
 * heading prose resolve through `@canlang/values` `resolveVariant` ONLY —
 * this module implements no second locale engine and never parses raw
 * description prose as parameterized ICU (literal braces pass through
 * untouched; only Markdown/HTML escaping applies).
 *
 * Determinism: same model + locale renders byte-identical output. The body
 * carries source/catalog/language version identity and no wall-clock
 * timestamps. Source links stay project-relative. The renderer writes no
 * files (stdout/file modes belong to the `can docs` CLI slice).
 */
import type {
  ReferenceAvailability,
  ReferenceDeclaration,
  ReferenceDescriptionValue,
  ReferenceExample,
  ReferenceModel,
  ReferenceOperation,
  ReferenceOwner,
} from "@canlang/contracts";
import { REFERENCE_MODEL_VERSION } from "@canlang/contracts";
import { resolveVariant, type MessageDescriptor } from "@canlang/values";

export interface ReferenceRenderOptions {
  /**
   * Explicit requested locale; null/omitted selects the model's app default
   * locale, never an ambient viewer locale.
   */
  readonly locale?: string | null;
}

export interface ResolvedReferenceText {
  /** Selected variant locale (matched tag, or source tag on fallback). */
  readonly tag: string;
  readonly text: string;
}

/**
 * Resolves one checked description to display prose via the shared static
 * locale resolver. Null variants are skipped (absent translation); empty
 * strings are selected as authored empty text.
 */
export function resolveReferenceDescription(
  description: ReferenceDescriptionValue,
  requested: string,
  appDefault: string,
): ResolvedReferenceText {
  const variants: Record<string, string | null> = {};
  for (const variant of description.variants) {
    variants[variant.tag] = variant.text;
  }
  const descriptor: MessageDescriptor = {
    kind: "message",
    source: description.source,
    variants,
  };
  const resolved = resolveVariant(descriptor, requested, appDefault, description.sourceLang);
  return { tag: resolved.tag, text: resolved.text };
}

// ---------------------------------------------------------------------------
// Reusable heading catalog (source English + Dutch variants)
// ---------------------------------------------------------------------------

type HeadingKey =
  | "title"
  | "owners"
  | "declarations"
  | "fields"
  | "field"
  | "type"
  | "nullable"
  | "required"
  | "default"
  | "constraints"
  | "description"
  | "operations"
  | "inputs"
  | "result"
  | "examples"
  | "availability"
  | "source"
  | "noDescription"
  | "authoredExample"
  | "statusUnknown";

const HEADING_SOURCE: Record<HeadingKey, string> = {
  title: "Internal declaration reference",
  owners: "Owners",
  declarations: "Declarations",
  fields: "Fields",
  field: "Field",
  type: "Type",
  nullable: "Nullable",
  required: "Required",
  default: "Default",
  constraints: "Constraints",
  description: "Description",
  operations: "Operations",
  inputs: "Inputs",
  result: "Result",
  examples: "Examples",
  availability: "Availability",
  source: "Source",
  noDescription: "No description.",
  authoredExample: "authored example",
  statusUnknown: "implementation status unknown",
};

const HEADING_VARIANTS: Record<HeadingKey, Record<string, string | null>> = {
  title: { nl: "Interne declaratie-referentie" },
  owners: { nl: "Eigenaren" },
  declarations: { nl: "Declaraties" },
  fields: { nl: "Velden" },
  field: { nl: "Veld" },
  type: { nl: "Type" },
  nullable: { nl: "Nullable" },
  required: { nl: "Verplicht" },
  default: { nl: "Standaard" },
  constraints: { nl: "Beperkingen" },
  description: { nl: "Beschrijving" },
  operations: { nl: "Operaties" },
  inputs: { nl: "Invoer" },
  result: { nl: "Resultaat" },
  examples: { nl: "Voorbeelden" },
  availability: { nl: "Beschikbaarheid" },
  source: { nl: "Bron" },
  noDescription: { nl: "Geen beschrijving." },
  authoredExample: { nl: "auteur-voorbeeld" },
  statusUnknown: { nl: "implementatiestatus onbekend" },
};

const HEADING_SOURCE_LANG = "en";

/**
 * Resolves one catalog heading through the shared static locale resolver.
 * Output is module-trusted (fixed en source + reviewed nl variants) and is
 * rendered WITHOUT the authored-prose escaper.
 */
function heading(key: HeadingKey, requested: string, appDefault: string): string {
  const descriptor: MessageDescriptor = {
    kind: "message",
    source: HEADING_SOURCE[key],
    variants: HEADING_VARIANTS[key],
  };
  return resolveVariant(descriptor, requested, appDefault, HEADING_SOURCE_LANG).text;
}

// ---------------------------------------------------------------------------
// Escaping and anchors
// ---------------------------------------------------------------------------

/** Escapes authored prose for Markdown body text (no prose injection). */
function escapeMarkdown(text: string): string {
  const inline = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/[`*_\[\]()#+\-!|{}]/g, (char) => `\\${char}`);
  // Periods stay literal except in a line-leading ordered-list marker.
  return inline
    .split("\n")
    .map((line) => line.replace(/^(\d+)\./, "$1\\."))
    .join("\n");
}

/** Preserves single-line authored code text in inline and GFM table contexts. */
function codeSpan(text: string, table = false): string {
  if (text === "" || (table && text.includes("|"))) {
    // Entities keep literal punctuation out of HTML parsing and table boundaries.
    const safe = text.replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g,
      (char) => `&#${char.charCodeAt(0)};`);
    return `<code>${safe}</code>`;
  }
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(longest + 1);
  // CommonMark strips one space at both edges unless the content is all spaces.
  const pad = text.startsWith("`") || text.endsWith("`") ||
    (text.startsWith(" ") && text.endsWith(" ") && /[^ ]/.test(text));
  return `${fence}${pad ? " " : ""}${text}${pad ? " " : ""}${fence}`;
}

/**
 * Readable base slug: lowercase alphanumerics joined by single hyphens.
 * Lossy on its own (`a_b`/`a__b`, case pairs and non-ASCII spellings can
 * share one base), so final anchors add a content-derived suffix ONLY when
 * distinct canonical identities collide on one base (see below).
 */
function slug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 ? "section" : slug;
}

/** FNV-1a 32-bit over UTF-16 code units: deterministic, platform-stable. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Independent second 32-bit lane (djb2-xor) for a wider digest. */
function djb2a32(text: string): number {
  let hash = 0x5381;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 16-hex-char content digest of one canonical identity. Case-, punctuation-
 * and Unicode-sensitive: any two distinct JS strings hash differently with
 * overwhelming probability, and the global assigner extends the suffix (then
 * falls back to a lossless encoding) so distinct identities never share a
 * final anchor.
 */
function identityDigest(canonical: string): string {
  return (
    fnv1a32(canonical).toString(16).padStart(8, "0") +
    djb2a32(canonical).toString(16).padStart(8, "0")
  );
}

/** Lossless anchor-safe encoding of one identity (injectivity fallback). */
function losslessHex(canonical: string): string {
  let out = "";
  for (let i = 0; i < canonical.length; i++) {
    out += canonical.charCodeAt(i).toString(16).padStart(4, "0");
  }
  return out.length === 0 ? "empty" : out;
}

function baseOwnerAnchor(owner: string): string {
  return `owner-${slug(owner)}`;
}

function baseDeclarationAnchor(owner: string, name: string): string {
  return `decl-${slug(owner)}-${slug(name)}`;
}

function baseOperationAnchor(id: string): string {
  return `op-${slug(id)}`;
}

function baseExampleAnchor(scope: string, label: string): string {
  return `ex-${slug(scope)}-${slug(label)}`;
}

/** Unambiguous hash input for one declaration identity (owner + name). */
function declarationKey(owner: string, name: string): string {
  return JSON.stringify([owner, name]);
}

/**
 * Unambiguous hash input for one example identity. The kind tag keeps a
 * declaration example and an operation example with equal scope/label
 * spellings distinct; the scope is `owner.name` for declarations and the
 * operation id for operations.
 */
function exampleKey(kind: string, scope: string, label: string): string {
  return JSON.stringify([kind, scope, label]);
}

/**
 * Assigns one globally-unique suffixed anchor for a canonical identity that
 * cannot keep its bare base. Tries the shortest non-colliding digest prefix
 * (`base-<hex>`, 8 to 16 hex chars) against the GLOBAL used set, then a
 * lossless `base-<digest>-<hex>` fallback, then a `-2`, `-3`, ... counter
 * for the theoretical cross-base collision of even the lossless form (an
 * author spelling that slugs to another identity's full suffixed anchor).
 * Deterministic: inputs are content-derived and callers iterate sorted.
 */
function suffixedAnchor(
  base: string,
  canonical: string,
  used: ReadonlySet<string>,
): string {
  const digest = identityDigest(canonical);
  for (let length = 8; length <= digest.length; length += 2) {
    const candidate = `${base}-${digest.slice(0, length)}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  const lossless = `${base}-${digest}-${losslessHex(canonical)}`;
  if (!used.has(lossless)) {
    return lossless;
  }
  let counter = 2;
  let candidate = `${lossless}-${counter}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${lossless}-${counter}`;
  }
  return candidate;
}

/** Precomputed collision-free anchors for every identity in one model. */
interface AnchorResolver {
  ownerAnchor(owner: string): string;
  declarationAnchor(owner: string, name: string): string;
  operationAnchor(id: string): string;
  exampleAnchor(kind: string, scope: string, label: string): string;
}

function pushDistinctIdentity(
  groups: Map<string, string[]>,
  seen: Set<string>,
  base: string,
  canonical: string,
): void {
  if (seen.has(canonical)) {
    return;
  }
  seen.add(canonical);
  const group = groups.get(base);
  if (group === undefined) {
    groups.set(base, [canonical]);
  } else {
    group.push(canonical);
  }
}

type AnchorKind = "owner" | "declaration" | "operation" | "example";

interface PendingIdentity {
  readonly kind: AnchorKind;
  readonly base: string;
  readonly canonical: string;
}

interface CollidingGroup {
  readonly kind: AnchorKind;
  readonly base: string;
  readonly canonicals: readonly string[];
}

/**
 * Builds the single anchor mapping for one render. Every TOC link and every
 * section anchor resolves through this resolver, so links can never dangle:
 * identical canonical identities always map to identical anchors.
 *
 * Global uniqueness (R-D07-02): final anchors are reserved in ONE global
 * namespace covering all base groups and all component kinds
 * (owners/declarations/operations/examples share the same HTML `id` space).
 * Lone identities keep their bare readable base when globally free
 * (processed first, in `(base, kind, canonical)` order); every other
 * identity gets a content-derived suffix avoiding ALL reserved names
 * (colliding groups in `(kind, base)` order, members in canonical order).
 * All ordering is content-sorted, so the same model in any input order
 * yields the same anchors (permutation-stable). Adding identities MAY
 * change existing anchors; model-addition stability is NOT guaranteed.
 */
function createAnchorResolver(model: ReferenceModel): AnchorResolver {
  const ownerGroups = new Map<string, string[]>();
  const declarationGroups = new Map<string, string[]>();
  const operationGroups = new Map<string, string[]>();
  const exampleGroups = new Map<string, string[]>();
  const seenOwners = new Set<string>();
  const seenDeclarations = new Set<string>();
  const seenOperations = new Set<string>();
  const seenExamples = new Set<string>();

  for (const owner of model.owners) {
    pushDistinctIdentity(ownerGroups, seenOwners, baseOwnerAnchor(owner.name), owner.name);
    for (const declaration of owner.declarations) {
      pushDistinctIdentity(
        declarationGroups,
        seenDeclarations,
        baseDeclarationAnchor(declaration.owner, declaration.name),
        declarationKey(declaration.owner, declaration.name),
      );
      const scope = `${declaration.owner}.${declaration.name}`;
      for (const example of declaration.examples) {
        pushDistinctIdentity(
          exampleGroups,
          seenExamples,
          baseExampleAnchor(scope, example.label),
          exampleKey("decl", scope, example.label),
        );
      }
    }
    for (const operation of owner.operations) {
      pushDistinctIdentity(
        operationGroups,
        seenOperations,
        baseOperationAnchor(operation.id),
        operation.id,
      );
      for (const example of operation.examples ?? []) {
        pushDistinctIdentity(
          exampleGroups,
          seenExamples,
          baseExampleAnchor(operation.id, example.label),
          exampleKey("op", operation.id, example.label),
        );
      }
    }
  }

  const lone: PendingIdentity[] = [];
  const colliding: CollidingGroup[] = [];
  const split = (kind: AnchorKind, groups: Map<string, string[]>): void => {
    for (const [base, canonicals] of groups) {
      if (canonicals.length <= 1) {
        const only = canonicals[0];
        if (only !== undefined) {
          lone.push({ kind, base, canonical: only });
        }
      } else {
        colliding.push({ kind, base, canonicals: [...canonicals] });
      }
    }
  };
  split("owner", ownerGroups);
  split("declaration", declarationGroups);
  split("operation", operationGroups);
  split("example", exampleGroups);

  lone.sort((a, b) =>
    a.base < b.base
      ? -1
      : a.base > b.base
        ? 1
        : a.kind < b.kind
          ? -1
          : a.kind > b.kind
            ? 1
            : a.canonical < b.canonical
              ? -1
              : a.canonical > b.canonical
                ? 1
                : 0,
  );
  colliding.sort((a, b) =>
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.base < b.base ? -1 : a.base > b.base ? 1 : 0,
  );

  const used = new Set<string>();
  const owners = new Map<string, string>();
  const declarations = new Map<string, string>();
  const operations = new Map<string, string>();
  const examples = new Map<string, string>();
  const targetFor = (kind: AnchorKind): Map<string, string> => {
    switch (kind) {
      case "owner":
        return owners;
      case "declaration":
        return declarations;
      case "operation":
        return operations;
      case "example":
        return examples;
    }
  };

  for (const identity of lone) {
    const target = targetFor(identity.kind);
    if (!used.has(identity.base)) {
      target.set(identity.canonical, identity.base);
      used.add(identity.base);
    } else {
      const anchor = suffixedAnchor(identity.base, identity.canonical, used);
      target.set(identity.canonical, anchor);
      used.add(anchor);
    }
  }
  for (const group of colliding) {
    const target = targetFor(group.kind);
    for (const canonical of [...group.canonicals].sort()) {
      const anchor = suffixedAnchor(group.base, canonical, used);
      target.set(canonical, anchor);
      used.add(anchor);
    }
  }

  return {
    ownerAnchor: (owner) => owners.get(owner) ?? baseOwnerAnchor(owner),
    declarationAnchor: (owner, name) =>
      declarations.get(declarationKey(owner, name)) ?? baseDeclarationAnchor(owner, name),
    operationAnchor: (id) => operations.get(id) ?? baseOperationAnchor(id),
    exampleAnchor: (kind, scope, label) =>
      examples.get(exampleKey(kind, scope, label)) ?? baseExampleAnchor(scope, label),
  };
}

/** Fenced code block with a fence longer than any backtick run inside. */
function codeBlock(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) {
    if (run.length > longest) longest = run.length;
  }
  const fence = "`".repeat(longest + 3);
  return `${fence}\n${text}\n${fence}`;
}

// ---------------------------------------------------------------------------
// Model validation (truthful failure on malformed input)
// ---------------------------------------------------------------------------

function fail(what: string): never {
  throw new Error(`invalid reference model: ${what}`);
}

function assertReferenceModel(model: ReferenceModel): void {
  if (typeof model !== "object" || model === null || Array.isArray(model)) {
    fail("model must be an object");
  }
  if (model.version !== REFERENCE_MODEL_VERSION) {
    fail(`unsupported version ${String(model.version)}`);
  }
  if (typeof model.sourceRevision !== "string") fail("sourceRevision must be text");
  if (typeof model.catalogVersion !== "string" && model.catalogVersion !== null) {
    fail("catalogVersion must be text or null");
  }
  if (typeof model.languageVersion !== "string") fail("languageVersion must be text");
  if (typeof model.appDefaultLocale !== "string") fail("appDefaultLocale must be text");
  if (!Array.isArray(model.owners)) fail("owners must be an array");
  const availability = model.availability as ReferenceAvailability | undefined;
  if (typeof availability !== "object" || availability === null) {
    fail("availability must be an object");
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface RenderContext {
  readonly requested: string;
  readonly appDefault: string;
}

function describeText(
  description: ReferenceDescriptionValue | undefined,
  context: RenderContext,
): string {
  if (description === undefined) {
    // Catalog string (module-trusted), not authored prose: no escaping.
    return heading("noDescription", context.requested, context.appDefault);
  }
  const resolved = resolveReferenceDescription(description, context.requested, context.appDefault);
  return escapeMarkdown(resolved.text);
}

function sourceLine(
  sourceId: string,
  start: number,
  end: number,
  context: RenderContext,
): string {
  const label = heading("source", context.requested, context.appDefault);
  return `- ${label}: ${codeSpan(sourceId)} (${start}–${end})`;
}

function renderDeclaration(
  declaration: ReferenceDeclaration,
  context: RenderContext,
  lines: string[],
  anchors: AnchorResolver,
): void {
  const anchor = anchors.declarationAnchor(declaration.owner, declaration.name);
  lines.push(`<a id="${anchor}"></a>`, "");
  lines.push(`##### ${codeSpan(`${declaration.owner}.${declaration.name}`)} (${declaration.kind})`, "");
  lines.push(describeText(declaration.description, context), "");
  lines.push(
    sourceLine(declaration.location.sourceId, declaration.location.start, declaration.location.end, context),
    "",
  );

  const fieldsLabel = heading("fields", context.requested, context.appDefault);
  lines.push(`**${fieldsLabel}**`, "");
  if (declaration.fields.length === 0) {
    lines.push(heading("noDescription", context.requested, context.appDefault), "");
  } else {
    const head = (key: HeadingKey): string =>
      heading(key, context.requested, context.appDefault);
    lines.push(
      `| ${head("field")} | ${head("type")} | ${head("nullable")} | ${head("required")} | ${head("default")} | ${head("constraints")} | ${head("description")} |`,
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const field of declaration.fields) {
      const constraints =
        field.constraints.length === 0
          ? "—"
          : field.constraints
              .map((constraint) => escapeMarkdown(`${constraint.kind}: ${constraint.detail}`))
              .join("; ");
      lines.push(
        `| ${codeSpan(field.name, true)} | ${codeSpan(field.type, true)} | ${field.nullable ? "yes" : "no"} | ${field.creationRequired ? "yes" : "no"} | ${field.default === undefined ? "—" : codeSpan(field.default, true)} | ${constraints} | ${describeText(field.description, context)} |`,
      );
    }
    lines.push("");
  }

  renderExamples(declaration.examples, "decl", `${declaration.owner}.${declaration.name}`, context, lines, anchors);
}

/**
 * Renders one authored-examples section (declaration fixtures or operation
 * table rows): every entry labeled as authored with its source plus the
 * stated expectation. No execution status is rendered — the model carries
 * none. Each entry gets a stable resolver anchor for deep links; the TOC
 * keeps owner/declaration/operation granularity, so no new TOC links mean
 * no new dangling targets.
 */
function renderExamples(
  examples: readonly ReferenceExample[],
  kind: string,
  scope: string,
  context: RenderContext,
  lines: string[],
  anchors: AnchorResolver,
): void {
  if (examples.length === 0) {
    return;
  }
  const examplesLabel = heading("examples", context.requested, context.appDefault);
  const authoredLabel = heading("authoredExample", context.requested, context.appDefault);
  lines.push(`**${examplesLabel}**`, "");
  for (const example of examples) {
    lines.push(`<a id="${anchors.exampleAnchor(kind, scope, example.label)}"></a>`, "");
    lines.push(`- **${authoredLabel}** ${codeSpan(example.label)}`, "");
    lines.push(codeBlock(example.source), "");
    if (example.expected !== undefined) {
      lines.push(codeBlock(example.expected), "");
    }
  }
}

function renderOperation(
  operation: ReferenceOperation,
  context: RenderContext,
  lines: string[],
  anchors: AnchorResolver,
): void {
  const anchor = anchors.operationAnchor(operation.id);
  lines.push(`<a id="${anchor}"></a>`, "");
  lines.push(`##### ${codeSpan(operation.id)}`, "");
  lines.push(describeText(operation.description, context), "");
  lines.push(
    sourceLine(operation.location.sourceId, operation.location.start, operation.location.end, context),
    "",
  );

  const head = (key: HeadingKey): string =>
    heading(key, context.requested, context.appDefault);
  lines.push(`**${head("inputs")}**`, "");
  if (operation.inputs.length === 0) {
    lines.push(heading("noDescription", context.requested, context.appDefault), "");
  } else {
    lines.push(
      `| ${head("field")} | ${head("type")} | ${head("nullable")} | ${head("required")} | ${head("default")} | ${head("constraints")} | ${head("description")} |`,
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const input of operation.inputs) {
      const constraints =
        input.constraints.length === 0
          ? "—"
          : input.constraints
              .map((constraint) => escapeMarkdown(`${constraint.kind}: ${constraint.detail}`))
              .join("; ");
      lines.push(
        `| ${codeSpan(input.name, true)} | ${codeSpan(input.type, true)} | ${input.nullable ? "yes" : "no"} | ${input.creationRequired ? "yes" : "no"} | ${input.default === undefined ? "—" : codeSpan(input.default, true)} | ${constraints} | ${describeText(input.description, context)} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    `**${head("result")}**: ${codeSpan(operation.result.type)} (${head("nullable")}: ${operation.result.nullable ? "yes" : "no"})`,
    "",
  );
  lines.push(describeText(operation.result.description, context), "");
  // `?? []`: pre-R4 payloads omit the key and render as before.
  renderExamples(operation.examples ?? [], "op", operation.id, context, lines, anchors);
}

function renderOwner(
  owner: ReferenceOwner,
  context: RenderContext,
  lines: string[],
  anchors: AnchorResolver,
): void {
  lines.push(`<a id="${anchors.ownerAnchor(owner.name)}"></a>`, "");
  lines.push(`### ${codeSpan(owner.name)}`, "");
  const declarationsLabel = heading("declarations", context.requested, context.appDefault);
  const operationsLabel = heading("operations", context.requested, context.appDefault);
  lines.push(`#### ${declarationsLabel}`, "");
  for (const declaration of owner.declarations) {
    renderDeclaration(declaration, context, lines, anchors);
  }
  lines.push(`#### ${operationsLabel}`, "");
  for (const operation of owner.operations) {
    renderOperation(operation, context, lines, anchors);
  }
}

function renderAvailability(
  availability: ReferenceAvailability,
  context: RenderContext,
  lines: string[],
): void {
  const label = heading("availability", context.requested, context.appDefault);
  lines.push(`## ${label}`, "");
  if (availability.status === "unknown") {
    const unknown = heading("statusUnknown", context.requested, context.appDefault);
    lines.push(`**${unknown}**`, "");
    return;
  }
  lines.push(`- Owner: ${codeSpan(availability.owner)}`, "");
  lines.push(`- Catalog: ${codeSpan(availability.catalog)}`, "");
}

/**
 * Renders the frozen reference model v1 as localized Markdown.
 *
 * Locale selection: `options.locale` (or null/omitted for the model's app
 * default) drives every description and heading through `resolveVariant`.
 * Throws a truthful error on malformed models or invalid locale tags.
 */
export function renderReferenceMarkdown(
  model: ReferenceModel,
  options: ReferenceRenderOptions = {},
): string {
  assertReferenceModel(model);
  const appDefault = model.appDefaultLocale;
  const requested = options.locale ?? appDefault;
  const context: RenderContext = { requested, appDefault };

  const lines: string[] = [];
  lines.push(`# ${heading("title", requested, appDefault)}`, "");
  lines.push(`- Source revision: ${codeSpan(model.sourceRevision)}`);
  lines.push(`- Catalog version: ${model.catalogVersion === null ? "none" : codeSpan(model.catalogVersion)}`);
  lines.push(`- Language version: ${codeSpan(model.languageVersion)}`);
  lines.push(`- Requested locale: ${codeSpan(requested)}`);
  lines.push(`- App default locale: ${codeSpan(appDefault)}`, "");

  const anchors = createAnchorResolver(model);

  const ownersLabel = heading("owners", requested, appDefault);
  lines.push(`## ${ownersLabel}`, "");
  for (const owner of model.owners) {
    lines.push(`- [${codeSpan(owner.name)}](#${anchors.ownerAnchor(owner.name)})`);
    for (const declaration of owner.declarations) {
      const anchor = anchors.declarationAnchor(declaration.owner, declaration.name);
      lines.push(`  - [${codeSpan(`${declaration.owner}.${declaration.name}`)}](#${anchor})`);
    }
    for (const operation of owner.operations) {
      lines.push(`  - [${codeSpan(operation.id)}](#${anchors.operationAnchor(operation.id)})`);
    }
  }
  lines.push("");

  for (const owner of model.owners) {
    renderOwner(owner, context, lines, anchors);
  }
  renderAvailability(model.availability, context, lines);
  return `${lines.join("\n").trimEnd()}\n`;
}
