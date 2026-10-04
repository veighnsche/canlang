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
  MessageDescriptor,
  MessageParamValue,
  MessageValue,
  PresentationContext,
  RowView,
  SharedStateProps,
  TextProps,
  TextValue,
  TitleProps,
} from "../../contracts/src/presentation.js";
import { escapeHtml, isolate } from "./escape.js";
import {
  canonicalDefaultTag,
  canonicalPreferredTags,
  formatIntExact,
  formatScalar,
  resolveCaption,
} from "./messages.js";

/** Page locale: first valid viewer preference, else the app default. */
function pageLocaleOf(context: PresentationContext): string {
  const preferred = canonicalPreferredTags(context.preferredLocales);
  return preferred[0] ?? canonicalDefaultTag(context.appDefaultLocale);
}

function isMessageDescriptor(
  value: MessageDescriptor | MessageParamValue,
): value is MessageDescriptor {
  return typeof (value as MessageDescriptor).source === "string";
}

const TITLE_CLASSES = {
  1: "text-3xl font-bold",
  2: "text-2xl font-bold",
  3: "text-xl font-bold",
} as const;

/**
 * Render one `text` value to escaped, bidi-isolated HTML text. Sync so
 * collections/forms can reuse it inside row loops. Callers must not re-escape
 * the result. Raw numbers are accepted for safe integers only; decimals and
 * other typed scalars need an explicit {type, value} pair.
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
  if (isMessageDescriptor(value)) {
    return isolate(escapeHtml(resolveCaption(value, context)));
  }
  return isolate(
    escapeHtml(
      formatScalar(value, {
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

/** daisyUI card: resolved title plus awaited children, optional 2-col grid. */
export async function card(props: CardProps): Promise<string> {
  const heading = escapeHtml(resolveCaption(props.title, props.context));
  const kids = typeof props.children === "function" ? await props.children() : props.children;
  const rendered = (await Promise.all(kids)).join("");
  const body =
    props.layout === "columns"
      ? `<div class="grid gap-4 sm:grid-cols-2">${rendered}</div>`
      : rendered;
  return `<section class="card bg-base-100 shadow"><div class="card-body"><h2 class="card-title">${heading}</h2>${body}</div></section>`;
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

/** One paragraph of space-joined text values. */
export async function text(props: TextProps): Promise<string> {
  const parts = props.values.map((value) => renderTextValue(value, props.context));
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

/** Shared loading/empty/error states with resolved, escaped messages. */
export async function renderState(props: SharedStateProps): Promise<string> {
  const note = escapeHtml(resolveCaption(props.message, props.context));
  switch (props.kind) {
    case "loading":
      return `<div role="status"><span class="loading loading-spinner"></span><div class="skeleton h-4 w-full"></div><p>${note}</p></div>`;
    case "empty":
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
