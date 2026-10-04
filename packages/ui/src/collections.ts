/**
 * List/table collection renderers (S3 seed; S5 adds controls here).
 *
 * Both factories render exactly what the dispatcher's authorized row query
 * returns: the runner enforces grants, limits and projection, so forbidden
 * fields never reach props and can never enter HTML. Query failures
 * propagate untouched; the dispatcher maps them to error pages.
 */

import type {
  ColumnMeta,
  ListProps,
  ListQueryArgs,
  PageChildren,
  PresentationContext,
  RowView,
  TableProps,
} from "../../contracts/src/presentation.js";
import { renderState, rowHeading } from "./components.js";
import { escapeAttr, escapeHtml } from "./escape.js";
import {
  canonicalDefaultTag,
  canonicalPreferredTags,
  formatScalar,
  message,
  resolveCaption,
} from "./messages.js";

/**
 * "More rows" wording, en source + nl variant. Follows the shell.ts chrome
 * pattern; S5 replaces this note with pagination controls.
 */
const MORE_ROWS = message("More rows available.", {
  nl: "Meer rijen beschikbaar.",
});

/** Scalar cell types rendered through formatScalar; see renderCell. */
const SCALAR_CELL_TYPES = new Set([
  "text",
  "email",
  "url",
  "timezone",
  "locale",
  "currency",
  "int",
  "decimal",
  "money",
  "date",
  "datetime",
]);

/** Pass S3 query args through, including only defined optionals. */
function queryArgs(
  props: Pick<ListProps, "parent" | "where" | "limit" | "cursor">,
): ListQueryArgs {
  return {
    ...(props.parent === undefined ? {} : { parent: props.parent }),
    ...(props.where === undefined ? {} : { where: props.where }),
    ...(props.limit === undefined ? {} : { limit: props.limit }),
    ...(props.cursor === undefined ? {} : { cursor: props.cursor }),
  };
}

/** Resolve page children (array or thunk of string/promise parts) to HTML. */
async function resolveChildren(children: PageChildren): Promise<string> {
  const parts = typeof children === "function" ? await children() : children;
  return (await Promise.all(parts)).join("");
}

/** Cell locale: first valid preferred locale, else the app default. */
function cellLocale(context: PresentationContext): string {
  const preferred = canonicalPreferredTags(context.preferredLocales);
  const first = preferred[0];
  if (first !== undefined) {
    return first;
  }
  return canonicalDefaultTag(context.appDefaultLocale);
}

/** Trailing more-note when the runner reports another page. */
function moreNote(context: PresentationContext, nextCursor: string | undefined): string {
  if (nextCursor === undefined) {
    return "";
  }
  return `<p class="can-more" data-cursor="${escapeAttr(nextCursor)}">${escapeHtml(resolveCaption(MORE_ROWS, context))}</p>`;
}

/**
 * Render one row list. renderRow receives the shared PresentationContext as
 * its view: row scope arrives via the row argument (closure over renderRow);
 * parent-chain scopes are a later extension.
 */
export async function list(props: ListProps): Promise<string> {
  const result = await props.context.query(
    props.context.invocation,
    props.model,
    queryArgs(props),
  );
  if (result.rows.length === 0) {
    return renderState({ context: props.context, kind: "empty", message: props.empty });
  }
  const items: string[] = [];
  for (const row of result.rows) {
    const body = await resolveChildren(props.renderRow(row, props.context));
    items.push(`<li class="list-row">${body}</li>`);
  }
  return `<ul class="list">${items.join("")}</ul>${moreNote(props.context, result.nextCursor)}`;
}

/** Render one model table over the requested column subset. */
export async function table(props: TableProps): Promise<string> {
  const result = await props.context.query(
    props.context.invocation,
    props.model,
    queryArgs(props),
  );
  const byField = new Map<string, ColumnMeta>();
  for (const column of result.columns) {
    byField.set(column.field, column);
  }
  const missing = props.columns.filter((field) => !byField.has(field));
  if (missing.length > 0) {
    throw new Error(`table "${props.model}": missing columns: ${missing.join(", ")}`);
  }
  if (result.rows.length === 0) {
    return renderState({ context: props.context, kind: "empty", message: props.empty });
  }
  const metas: ColumnMeta[] = [];
  for (const field of props.columns) {
    const meta = byField.get(field);
    if (meta === undefined) {
      // Unreachable: missing fields threw above.
      throw new Error(`table "${props.model}": missing columns: ${field}`);
    }
    metas.push(meta);
  }
  const head = metas
    .map((meta) => `<th>${escapeHtml(resolveCaption(meta.label, props.context))}</th>`)
    .join("");
  const body: string[] = [];
  for (const row of result.rows) {
    const cells = metas
      .map((meta) => `<td>${renderCell(meta, row.fields[meta.field], props.context)}</td>`)
      .join("");
    body.push(`<tr>${cells}</tr>`);
  }
  return (
    `<table class="table"><thead><tr>${head}</tr></thead>` +
    `<tbody>${body.join("")}</tbody></table>${moreNote(props.context, result.nextCursor)}`
  );
}

/**
 * Render one cell. Bool/enum-typed columns (type "bool", "enum" or a dotted
 * qualified enum id) render badges; scalar types render through
 * formatScalar; reference/file/array/object-typed columns render nested
 * RowView values via rowHeading or {id}-shaped values as plain ids. Nullish
 * values render empty, matching TextValue semantics. Failures rethrow as
 * `column <field>: <cause>`; successful output passes through untouched.
 */
function renderCell(meta: ColumnMeta, value: unknown, context: PresentationContext): string {
  try {
    return renderCellInner(meta, value, context);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`column ${meta.field}: ${cause}`);
  }
}

function renderCellInner(
  meta: ColumnMeta,
  value: unknown,
  context: PresentationContext,
): string {
  if (value === null || value === undefined) {
    return "";
  }
  // Badge-worthy values are booleans and stable case-name strings; object
  // values (nested rows, id shapes, money) keep their own branches below even
  // when the type id is dotted (e.g. model references).
  if (
    (meta.type === "bool" || meta.type === "enum" || meta.type.includes(".")) &&
    (typeof value === "boolean" || typeof value === "string")
  ) {
    return renderBadge(meta, value, context);
  }
  if (SCALAR_CELL_TYPES.has(meta.type)) {
    const scales = context.currencyScales;
    const text = formatScalar(
      { type: meta.type, value },
      {
        locale: cellLocale(context),
        timeZone: "UTC",
        ...(scales === undefined ? {} : { currencyScales: scales }),
      },
    );
    return escapeHtml(text);
  }
  return renderStructural(meta, value, context);
}

/** Badge cell: valueLabels caption when present, else the raw stable key. */
function renderBadge(meta: ColumnMeta, value: unknown, context: PresentationContext): string {
  let key: string;
  if (meta.type === "bool") {
    if (typeof value !== "boolean") {
      throw new TypeError("bool column needs a boolean value");
    }
    key = value ? "true" : "false";
  } else {
    if (typeof value !== "string") {
      throw new TypeError("enum column needs a stable case name");
    }
    key = value;
  }
  const labeled = meta.valueLabels?.[key];
  const text = labeled === undefined ? key : resolveCaption(labeled, context);
  return `<span class="badge">${escapeHtml(text)}</span>`;
}

/** Structural cell: nested row heading, {id} fallback, else a precise throw. */
function renderStructural(
  meta: ColumnMeta,
  value: unknown,
  context: PresentationContext,
): string {
  if (isRowView(value)) {
    return rowHeading(value, meta.label, context);
  }
  if (isIdShaped(value)) {
    return escapeHtml(value.id);
  }
  throw new Error(`unsupported column type "${meta.type}"`);
}

function isRowView(value: unknown): value is RowView {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { readonly id?: unknown; readonly fields?: unknown };
  return (
    typeof candidate.id === "string" &&
    typeof candidate.fields === "object" &&
    candidate.fields !== null &&
    !Array.isArray(candidate.fields)
  );
}

function isIdShaped(value: unknown): value is { readonly id: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return typeof (value as { readonly id?: unknown }).id === "string";
}
