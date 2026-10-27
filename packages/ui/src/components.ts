/**
 * Core presentational components (S3): card, title, text, content and shared
 * states, plus the text-value and row-heading helpers reused by
 * collections/forms.
 *
 * Scope-transparent grouping only: these factories arrange already-authorized
 * content and apply no record/query/permission semantics. Every dynamic string
 * is resolved through message captions, escaped for its sink, and bidi-
 * isolated where interpolated. content() renders plain text only, never raw
 * HTML; card children are trusted pre-rendered HTML from sibling factories.
 */

import type {
  CardProps,
  ContentProps,
  FileValue,
  FileLinkView,
  GeneratedViewInstanceProps,
  MessageDescriptor,
  MessageParamValue,
  MessageValue,
  PresentationContext,
  ResolvedMessage,
  RowView,
  SharedStateProps,
  TextProps,
  TextValue,
  TitleProps,
} from "@canlang/contracts";
import {
  GENERATED_VIEW_ATTR,
  assertGeneratedViewInstanceProps,
} from "@canlang/contracts";
import { nativeTextScalar } from "./internal/native-text.js";
import { partitionActionGroups } from "./internal/action-groups.js";
import { checkedFile, checkedFileLink } from "./internal/file-link.js";
import { escapeAttr, escapeHtml, isolate } from "./escape.js";
import {
  canonicalDefaultTag,
  canonicalPreferredTags,
  formatIntExact,
  formatMessageResult,
  formatScalar,
  resolveCaption,
  resolvedText,
  message,
} from "./messages.js";

/** Page locale: first valid viewer preference, else the app default. */
function pageLocaleOf(context: PresentationContext): string {
  const preferred = canonicalPreferredTags(context.preferredLocales);
  return preferred[0] ?? canonicalDefaultTag(context.appDefaultLocale);
}

function isMessageDescriptor(
  value: object,
): value is MessageDescriptor {
  return typeof (value as MessageDescriptor).source === "string";
}

const TITLE_CLASSES = {
  1: "text-3xl font-bold",
  2: "text-2xl font-bold",
  3: "text-xl font-bold",
} as const;

/** Final text keeps the effective language selected by its producer. */
function renderResolvedText(value: ResolvedMessage): string {
  return `<span lang="${escapeAttr(value.locale)}" dir="auto">${isolate(escapeHtml(value.text))}</span>`;
}

/**
 * Render one `text` value to escaped, bidi-isolated HTML text. Sync so
 * collections/forms can reuse it inside row loops. Callers must not re-escape
 * the result. Raw numbers are accepted for safe integers only. Native
 * user/datetime/money values retain their checked representation; other typed
 * scalars, including decimals, need an explicit {type, value} pair.
 */
export function renderTextValue(value: TextValue, context: PresentationContext): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return isolate(escapeHtml(value));
  }
  if (typeof value === "boolean") {
    return isolate(value ? "true" : "false");
  }
  if (typeof value === "bigint") {
    return isolate(formatIntExact(value, pageLocaleOf(context)));
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `text value ${String(value)}: non-integer numbers need an explicit {type, value} pair (e.g. {type: "decimal", value: "..."})`,
      );
    }
    return isolate(formatIntExact(BigInt(value), pageLocaleOf(context)));
  }
  const scalar = nativeTextScalar(value);
  const formatted = resolvedText(value);
  if (formatted !== undefined) {
    return renderResolvedText(formatted);
  }
  if (isMessageDescriptor(value)) {
    if (value.sourceLocale !== undefined) {
      return renderResolvedText(formatMessageResult(value, {
        preferredLocales: canonicalPreferredTags(context.preferredLocales),
        appDefaultLocale: canonicalDefaultTag(context.appDefaultLocale),
        timeZone: "UTC",
        ...(context.currencyScales === undefined ? {} : { currencyScales: context.currencyScales }),
      }));
    }
    return isolate(escapeHtml(resolveCaption(value, context)));
  }
  return isolate(
    escapeHtml(
      formatScalar(scalar ?? (value as MessageParamValue), {
        locale: pageLocaleOf(context),
        timeZone: "UTC",
        ...(context.currencyScales !== undefined
          ? { currencyScales: context.currencyScales }
          : {}),
      }),
    ),
  );
}

/**
 * Row label rule over the supplied authorized projection only: the first
 * nonempty non-whitespace exact-string `title`, else `name`, else
 * "<model caption> <id>". Returns escaped text; callers must not re-escape.
 * Assemblers (cells, generated rows) apply bidi isolation around the result;
 * this helper does not isolate, so nested use never double-wraps.
 */
export function rowHeading(
  row: RowView,
  modelCaption: MessageValue,
  context: PresentationContext,
): string {
  const title = row.fields["title"];
  if (typeof title === "string" && title.trim() !== "") {
    return escapeHtml(title);
  }
  const name = row.fields["name"];
  if (typeof name === "string" && name.trim() !== "") {
    return escapeHtml(name);
  }
  return escapeHtml(`${resolveCaption(modelCaption, context)} ${row.id}`);
}

/** daisyUI card: optional resolved title plus awaited children and 2-col grid. */
export async function card(props: CardProps): Promise<string> {
  const heading = props.title === undefined ? "" : `<h2 class="card-title">${escapeHtml(resolveCaption(props.title, props.context))}</h2>`;
  const kids = typeof props.children === "function" ? await props.children() : props.children;
  const parts = await Promise.all(kids);
  // Controls evaluate in authored order; only their completed presentation
  // moves into its owning heading or footer region.
  const { primary, secondary, body: rendered } = partitionActionGroups(parts);
  const body =
    props.layout === "columns" && rendered !== ""
      ? `<div class="grid gap-4 sm:grid-cols-2">${rendered}</div>`
      : rendered;
  const header = secondary === "" ? heading
    : `<div class="can-card-heading">${heading}<div class="can-heading-actions">${secondary}</div></div>`;
  const footer = primary === "" ? "" : `<footer class="can-card-footer">${primary}</footer>`;
  return `<section class="card bg-base-100 shadow" data-can-card><div class="card-body">${header}${body}${footer}</div></section>`;
}

/** Semantic heading; defaults to level 2 when no level is given. */
export async function title(props: TitleProps): Promise<string> {
  const level = props.level ?? 2;
  if (level !== 1 && level !== 2 && level !== 3) {
    throw new RangeError(`title level must be 1, 2 or 3, got ${String(level)}`);
  }
  const text = escapeHtml(resolveCaption(props.text, props.context));
  return `<h${String(level)} class="${TITLE_CLASSES[level]}">${text}</h${String(level)}>`;
}

const NO_FILES = message("No files", { nl: "Geen bestanden" });
const FILE_UNAVAILABLE = message("File unavailable", { nl: "Bestand niet beschikbaar" });

function textFileLink(view: FileLinkView | null, context: PresentationContext): string {
  if (view === null) return isolate(escapeHtml(resolveCaption(FILE_UNAVAILABLE, context)));
  const { href, caption, status } = checkedFileLink(view, context, "text");
  const statusHtml = status === undefined ? "" : ` <span role="status">${escapeHtml(status)}</span>`;
  return `<a class="link" href="${escapeAttr(href)}">${isolate(escapeHtml(caption))}</a>${statusHtml}`;
}

/** One paragraph of space-joined text and source-bound authorized File links. */
export async function text(props: TextProps): Promise<string> {
  // Complete validation and sequence snapshots precede every presenter await.
  // Retain original File objects: copied identities cannot acquire source scope.
  const values = [...props.values].map<{ files: FileValue[] } | { html: string }>(value => {
    if (Array.isArray(value)) {
      const files: FileValue[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new TypeError("text File arrays cannot be sparse");
        files.push(checkedFile(value[index], "text"));
      }
      return { files };
    }
    if (typeof value === "object" && value !== null &&
        Object.getOwnPropertyDescriptor(value, "kind")?.value === "file") {
      return { files: [checkedFile(value, "text")] };
    }
    return { html: renderTextValue(value as TextValue, props.context) };
  });
  const present = props.context.presentFile;
  if (values.some(value => "files" in value && value.files.length > 0) && typeof present !== "function") {
    throw new Error("text File presentation requires a source-bound presenter");
  }
  const parts: string[] = [];
  for (const value of values) {
    if ("html" in value) parts.push(value.html);
    else if (value.files.length === 0) parts.push(isolate(escapeHtml(resolveCaption(NO_FILES, props.context))));
    else {
      const links: string[] = [];
      for (const file of value.files) links.push(textFileLink(await present!(file), props.context));
      parts.push(links.join(" "));
    }
  }
  return `<p>${parts.join(" ")}</p>`;
}

/**
 * Plain-text body: descriptor values resolve first, blank lines split
 * paragraphs, single newlines become <br>. Never emits raw HTML.
 */
export async function content(props: ContentProps): Promise<string> {
  const raw =
    typeof props.value === "string" ? props.value : resolveCaption(props.value, props.context);
  const paragraphs = raw
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
  return paragraphs
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\r?\n/g, "<br>")}</p>`)
    .join("");
}

/** Stamp semantic HTML with the existing CSS ownership hooks, without wrappers.
 * Already-owned children expose their host to the parent and retain their interior.
 */
function stampTagEnd(html: string, start: number): number {
  let end = start + 1, quote = "";
  for (; end < html.length; end++) {
    const char = html[end];
    if (quote) { if (char === quote) quote = ""; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === ">") break;
  }
  return end;
}

function stampOpenTag(
  tag: string,
  name: string,
  stack: Array<{ name: string; blocked: boolean }>,
  unitId: string,
  useId: string,
  voids: ReadonlySet<string>,
  attr: (tag: string, name: string) => string | undefined,
  add: (tag: string, name: string, value: string) => string,
): string {
  const inheritedBlock = stack[stack.length - 1]?.blocked ?? false;
  const existing = attr(tag, "data-can-style");
  const ownRoot = stack.length === 0 && existing === unitId;
  // Standard action primitives own their appearance; generated styles may
  // arrange the containing region but never acquire their control subtree.
  const standardAction = /\sdata-can-(?:primary-actions|action-menu|standard-submit)(?:\s|>|=)/.test(tag);
  const boundary = standardAction || (!ownRoot && (existing !== undefined || (stack.length > 0 && /\sdata-can-view\s*=/.test(tag))));
  let stamped = tag;
  if (!inheritedBlock) {
    if (boundary) {
      stamped = add(stamped, "data-can-style-host", unitId);
      if (stack.length === 0) stamped = add(stamped, "data-can-style-root", `${unitId}:${useId}`);
    }
    else {
      if (existing === undefined) stamped = add(stamped, "data-can-style", unitId);
      if (stack.length === 0) stamped = add(stamped, "data-can-style-root", `${unitId}:${useId}`);
    }
  }
  if (!voids.has(name) && !/\/\s*>$/.test(stamped)) stack.push({ name, blocked: inheritedBlock || boundary });
  return stamped;
}

function stampStyledHtml(html: string, unitId: string, useId: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(unitId) || !useId) throw new Error("Invalid compiler style identity");
  const stack: Array<{name:string; blocked:boolean}> = [];
  const voids = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
  const raw = new Set(["script","style","textarea","title"]);
  let output = "", cursor = 0;
  const attr = (tag:string, name:string): string | undefined => {
    const match = new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tag);
    return match?.[2];
  };
  const add = (tag:string, name:string, value:string): string => {
    const pattern = new RegExp(`(\\s${name}\\s*=\\s*)(["'])(.*?)\\2`, "i");
    const match = pattern.exec(tag);
    if (match) {
      const tokens = new Set((match[3] ?? "").split(/\s+/).filter(Boolean)); tokens.add(value);
      return tag.replace(pattern, (_all, prefix:string) => `${prefix}"${escapeAttr([...tokens].join(" "))}"`);
    }
    return tag.replace(/\s*\/?>$/, ending => ` ${name}="${escapeAttr(value)}"${ending}`);
  };
  while (cursor < html.length) {
    const top = stack[stack.length - 1];
    if (top !== undefined && raw.has(top.name)) {
      const close = html.toLowerCase().indexOf(`</${top.name}`, cursor);
      if (close < 0) { output += html.slice(cursor); break; }
      output += html.slice(cursor, close); cursor = close;
    }
    const start = html.indexOf("<", cursor);
    if (start < 0) { output += html.slice(cursor); break; }
    output += html.slice(cursor, start);
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      const next = end < 0 ? html.length : end + 3;
      output += html.slice(start, next); cursor = next; continue;
    }
    const end = stampTagEnd(html, start);
    if (end === html.length) { output += html.slice(start); break; }
    let tag = html.slice(start, end + 1);
    const parsed = /^<(\/)?([A-Za-z][A-Za-z0-9:-]*)\b/.exec(tag);
    if (parsed === null) { output += tag; cursor = end + 1; continue; }
    const name = parsed[2]!.toLowerCase();
    if (parsed[1]) {
      const index = stack.map(entry => entry.name).lastIndexOf(name);
      if (index >= 0) stack.splice(index);
    } else {
      tag = stampOpenTag(tag, name, stack, unitId, useId, voids, attr, add);
    }
    output += tag; cursor = end + 1;
  }
  return output;
}

export function styledComponent(html: string, unitId: string, useId: string): string;
export function styledComponent(html: null, unitId: string, useId: string): null;
export function styledComponent(html: string | null, unitId: string, useId: string): string | null;
export function styledComponent(html: Promise<string | null>, unitId: string, useId: string): Promise<string | null>;
export function styledComponent(html: string | null | Promise<string | null>, unitId: string, useId: string): string | null | Promise<string | null>;
export function styledComponent(html: string | null | Promise<string | null>, unitId: string, useId: string): string | null | Promise<string | null> {
  const stamp = (value:string|null): string|null => value === null ? null : stampStyledHtml(value,unitId,useId);
  return typeof html === "object" && html !== null && "then" in html ? html.then(stamp) : stamp(html);
}

/**
 * BGI-09 row-bound instance root: admit the caller's props, invoke the
 * saved `render({row, bindings, ui})` exactly once with the already
 * evaluated row and pre-rendered bindings, and wrap the arranged HTML in
 * a compiler-owned instance root carrying the use identity plus the
 * definition's root-style hooks when declared. Repeated instances share
 * the renderer but never a root; the renderer cannot invent controls.
 */
export async function generatedViewInstance(props: GeneratedViewInstanceProps): Promise<string> {
  assertGeneratedViewInstanceProps(props);
  const bindings: Record<string, string> = {};
  for (const binding of props.bindings) {
    bindings[binding.name] = binding.html;
  }
  const arranged = await props.render({
    row: props.row,
    bindings,
    ui: { escapeHtml, escapeAttr },
  });
  // Mount presentation for the optional saved browser `mount`: the same
  // admitted row the renderer arranged, so browser enhancement never
  // refetches or re-derives it. Inert markup when the unit ships no
  // browser code.
  const presentation = escapeAttr(
    JSON.stringify({ view: props.descriptor.view, useId: props.useId, row: props.row }),
  );
  let html = `<section ${GENERATED_VIEW_ATTR}="${props.useId}" data-can-view-presentation="${presentation}">${arranged}</section>`;
  if (props.descriptor.rendererStyle !== undefined) html = stampStyledHtml(html, props.descriptor.rendererStyle, props.useId);
  if (props.descriptor.rootStyle !== undefined && props.descriptor.rootStyle !== props.descriptor.rendererStyle) {
    html = stampStyledHtml(html, props.descriptor.rootStyle, props.useId);
  }
  return html;
}

/** Shared loading/empty/error states with resolved, escaped messages. */
export async function renderState(props: SharedStateProps): Promise<string> {
  const note = escapeHtml(resolveCaption(props.message, props.context));
  switch (props.kind) {
    case "loading":
      return `<div role="status"><span class="loading loading-spinner"></span><div class="skeleton h-4 w-full"></div><p>${note}</p></div>`;
    case "empty":
      return `<p>${note}</p>`;
    case "no-match":
      return `<p>${note}</p>`;
    case "error": {
      const detail =
        props.detail === undefined
          ? ""
          : `<p>${escapeHtml(resolveCaption(props.detail, props.context))}</p>`;
      return `<div class="alert alert-error" role="alert"><p>${note}</p>${detail}</div>`;
    }
  }
}
