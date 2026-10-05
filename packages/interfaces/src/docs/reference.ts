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

/** Escapes a value rendered inside a Markdown code span. */
function escapeCodeSpan(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

function codeSpan(text: string): string {
  return `\`${escapeCodeSpan(text)}\``;
}

/** Stable anchor slug: lowercase alphanumerics joined by single hyphens. */
function slug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 ? "section" : slug;
}

function ownerAnchor(owner: string): string {
  return `owner-${slug(owner)}`;
}

function declarationAnchor(owner: string, name: string): string {
  return `decl-${slug(owner)}-${slug(name)}`;
}

function operationAnchor(id: string): string {
  return `op-${slug(id)}`;
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
): void {
  const anchor = declarationAnchor(declaration.owner, declaration.name);
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
        `| ${codeSpan(field.name)} | ${codeSpan(field.type)} | ${field.nullable ? "yes" : "no"} | ${field.creationRequired ? "yes" : "no"} | ${field.default === undefined ? "—" : codeSpan(field.default)} | ${constraints} | ${describeText(field.description, context)} |`,
      );
    }
    lines.push("");
  }

  if (declaration.examples.length > 0) {
    const examplesLabel = heading("examples", context.requested, context.appDefault);
    const authoredLabel = heading("authoredExample", context.requested, context.appDefault);
    lines.push(`**${examplesLabel}**`, "");
    for (const example of declaration.examples) {
      lines.push(`- **${authoredLabel}** ${codeSpan(example.label)}`, "");
      lines.push(codeBlock(example.source), "");
      if (example.expected !== undefined) {
        lines.push(codeBlock(example.expected), "");
      }
    }
  }
}

function renderOperation(
  operation: ReferenceOperation,
  context: RenderContext,
  lines: string[],
): void {
  const anchor = operationAnchor(operation.id);
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
        `| ${codeSpan(input.name)} | ${codeSpan(input.type)} | ${input.nullable ? "yes" : "no"} | ${input.creationRequired ? "yes" : "no"} | ${input.default === undefined ? "—" : codeSpan(input.default)} | ${constraints} | ${describeText(input.description, context)} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    `**${head("result")}**: ${codeSpan(operation.result.type)} (${head("nullable")}: ${operation.result.nullable ? "yes" : "no"})`,
    "",
  );
  lines.push(describeText(operation.result.description, context), "");
}

function renderOwner(owner: ReferenceOwner, context: RenderContext, lines: string[]): void {
  lines.push(`<a id="${ownerAnchor(owner.name)}"></a>`, "");
  lines.push(`### ${codeSpan(owner.name)}`, "");
  const declarationsLabel = heading("declarations", context.requested, context.appDefault);
  const operationsLabel = heading("operations", context.requested, context.appDefault);
  lines.push(`#### ${declarationsLabel}`, "");
  for (const declaration of owner.declarations) {
    renderDeclaration(declaration, context, lines);
  }
  lines.push(`#### ${operationsLabel}`, "");
  for (const operation of owner.operations) {
    renderOperation(operation, context, lines);
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

  const ownersLabel = heading("owners", requested, appDefault);
  lines.push(`## ${ownersLabel}`, "");
  for (const owner of model.owners) {
    lines.push(`- [${codeSpan(owner.name)}](#${ownerAnchor(owner.name)})`);
    for (const declaration of owner.declarations) {
      const anchor = declarationAnchor(declaration.owner, declaration.name);
      lines.push(`  - [${codeSpan(`${declaration.owner}.${declaration.name}`)}](#${anchor})`);
    }
    for (const operation of owner.operations) {
      lines.push(`  - [${codeSpan(operation.id)}](#${operationAnchor(operation.id)})`);
    }
  }
  lines.push("");

  for (const owner of model.owners) {
    renderOwner(owner, context, lines);
  }
  renderAvailability(model.availability, context, lines);
  return `${lines.join("\n").trimEnd()}\n`;
}
