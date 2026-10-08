/**
 * List/table collection renderers (S3 seed; S5 adds controls here).
 *
 * Both factories render exactly what the dispatcher's authorized row query
 * returns: the runner enforces grants, limits and projection, so forbidden
 * fields never reach props and can never enter HTML. Query failures
 * propagate untouched; the dispatcher maps them to error pages.
 */

import type {
  BoardProps,
  CollectionControls,
  ColumnMeta,
  CsvImportProps,
  CsvImportReview,
  FilterCondition,
  ListProps,
  ListQueryArgs,
  MessageValue,
  OrderSelector,
  PageChildren,
  PresentationContext,
  RowView,
  TableProps,
} from "@canlang/contracts";
import { CSRF_FIELD } from "@canlang/contracts";
import { appearanceClasses } from "./appearance.js";
import { pickAppearance } from "./internal/appearance-props.js";
import { renderState, rowHeading } from "./components.js";
import {
  csvFormulaProtect,
  escapeAttr,
  escapeHtml,
  isolate,
  isSafeUrl,
  safeHref,
} from "./escape.js";
import { assertRegionId, fragmentRegion, hxAttrs } from "./htmx.js";
import {
  canonicalDefaultTag,
  canonicalPreferredTags,
  formatScalar,
  isEnumTypeId,
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

/** Collection page-size bound: default 25 (runner), max 100, reject overflow. */
const MAX_LIMIT = 100;

/** Pass S3 query args through, including only defined optionals. */
function queryArgs(
  props: Pick<ListProps, "parent" | "where" | "limit" | "cursor">,
  factory: string,
): ListQueryArgs {
  if (
    props.limit !== undefined &&
    (!Number.isInteger(props.limit) || props.limit < 1 || props.limit > MAX_LIMIT)
  ) {
    throw new Error(`${factory}: limit must be an integer 1..${String(MAX_LIMIT)}`);
  }
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
  if (props.controls !== undefined) {
    assertControls(props.controls, "list");
    assertConsistentContext(props.context, props.controls.context, "list");
  }
  const result = await props.context.query(
    props.context.invocation,
    props.model,
    queryArgs(props, "list"),
  );
  if (result.rows.length === 0) {
    if (props.controls === undefined) {
      return renderState({ context: props.context, kind: "empty", message: props.empty });
    }
    return wrapWithControls(props.controls, await emptyBody(props.controls, props), props);
  }
  const items: string[] = [];
  for (const row of result.rows) {
    const body = await resolveChildren(await props.renderRow(row, props.context));
    items.push(`<li class="list-row">${body}</li>`);
  }
  const rowsHtml = `<ul class="list">${items.join("")}</ul>`;
  if (props.controls === undefined) {
    return `${rowsHtml}${moreNote(props.context, result.nextCursor)}`;
  }
  return wrapWithControls(props.controls, rowsHtml, props);
}

/** Render one model table over the requested column subset. */
export async function table(props: TableProps): Promise<string> {
  if (props.controls !== undefined) {
    assertControls(props.controls, "table");
    assertConsistentContext(props.context, props.controls.context, "table");
  }
  const result = await props.context.query(
    props.context.invocation,
    props.model,
    queryArgs(props, "table"),
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
    if (props.controls === undefined) {
      return renderState({ context: props.context, kind: "empty", message: props.empty });
    }
    return wrapWithControls(props.controls, await emptyBody(props.controls, props), props);
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
    .map((meta) => `<th scope="col">${escapeHtml(resolveCaption(meta.label, props.context))}</th>`)
    .join("");
  const body: string[] = [];
  for (const row of result.rows) {
    const cells = metas
      .map((meta) => `<td>${renderCell(meta, row.fields[meta.field], props.context)}</td>`)
      .join("");
    body.push(`<tr>${cells}</tr>`);
  }
  const rowsHtml =
    `<table class="table"><thead><tr>${head}</tr></thead>` +
    `<tbody>${body.join("")}</tbody></table>`;
  if (props.controls === undefined) {
    return `${rowsHtml}${moreNote(props.context, result.nextCursor)}`;
  }
  return wrapWithControls(props.controls, rowsHtml, props);
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
    const rendered = renderCellInner(meta, value, context);
    return rendered === "" ? "" : isolate(rendered);
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
  // when the type id is dotted (e.g. model references). Enum spellings align
  // with messages.ts via the shared predicate.
  if (meta.type === "bool") {
    return renderBadge(meta, value, context);
  }
  if (isEnumTypeId(meta.type) && typeof value === "string") {
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

// ---------------------------------------------------------------------------
// S5 collection controls: toolbar, pagination, export/print, no-match.
// ---------------------------------------------------------------------------

/** Closed generated filter-operator matrix; unknown operators fail closed. */
const FILTER_OPS: ReadonlySet<string> = new Set([
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
  "is_null",
  "not_null",
]);

/** Toolbar/chrome captions (ui.collections.*): en source + nl variant. */
const SEARCH_LABEL = message("Search", { nl: "Zoeken" });
const ORDER_LABEL = message("Order", { nl: "Sortering" });
const REMOVE_FILTER_LABEL = message("Remove filter", { nl: "Filter verwijderen" });
const PREV_LABEL = message("Previous", { nl: "Vorige" });
const NEXT_LABEL = message("Next", { nl: "Volgende" });
const EXPORT_LABEL = message("Export", { nl: "Exporteren" });
const PRINT_LABEL = message("Print", { nl: "Afdrukken" });
const CLEAR_LABEL = message("Clear search and filters", { nl: "Zoekopdracht en filters wissen" });
const NO_MATCH_NOTE = message("No matching results.", { nl: "Geen overeenkomende resultaten." });
const BETWEEN_AND = message("and", { nl: "en" });

/** Closed control-query state serialized by controlHref; nothing else. */
export interface ControlQueryState {
  readonly q?: string;
  readonly filters?: ReadonlyArray<FilterCondition>;
  readonly order?: ReadonlyArray<OrderSelector>;
  readonly cursor?: string;
}

/** Serialize one filter bound to query/chip text; objects fail closed. */
function scalarText(value: unknown, what: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${what} must be a finite number`);
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  throw new Error(`${what} must be a string, number, boolean or bigint`);
}

/** Fail closed on any condition outside the accepted filter matrix. */
function assertFilter(condition: FilterCondition, index: number): void {
  const what = `filter[${String(index)}]`;
  if (condition === null || typeof condition !== "object" || Array.isArray(condition)) {
    throw new Error(`${what} must be an object`);
  }
  if (typeof condition.field !== "string" || condition.field === "") {
    throw new Error(`${what}.field must be a nonempty string`);
  }
  if (!FILTER_OPS.has(condition.op)) {
    throw new Error(`${what}.op is not a known filter operator`);
  }
  const hasValue = condition.value !== undefined;
  const hasUpper = condition.upper !== undefined;
  switch (condition.op) {
    case "between":
      if (!hasValue || !hasUpper) {
        throw new Error(`${what}: between needs a value and an upper bound`);
      }
      scalarText(condition.value, `${what}.value`);
      scalarText(condition.upper, `${what}.upper`);
      break;
    case "is_null":
    case "not_null":
      if (hasValue || hasUpper) {
        throw new Error(`${what}: ${condition.op} takes no value`);
      }
      break;
    default:
      if (!hasValue) {
        throw new Error(`${what}: ${condition.op} needs a value`);
      }
      if (hasUpper) {
        throw new Error(`${what}: ${condition.op} takes no upper bound`);
      }
      scalarText(condition.value, `${what}.value`);
      break;
  }
}

/** Fail closed on any selector outside the accepted order shape. */
function assertOrder(selector: OrderSelector, index: number): void {
  const what = `order[${String(index)}]`;
  if (selector === null || typeof selector !== "object" || Array.isArray(selector)) {
    throw new Error(`${what} must be an object`);
  }
  if (typeof selector.field !== "string" || selector.field === "") {
    throw new Error(`${what}.field must be a nonempty string`);
  }
  if (selector.direction !== "asc" && selector.direction !== "desc") {
    throw new Error(`${what}.direction must be "asc" or "desc"`);
  }
}

/**
 * Validate accepted control state before any query or render: region shape,
 * string hrefs/cursors/query, and the closed filter/order matrices. Throws;
 * never coerces or drops a malformed condition.
 */
function assertControls(controls: CollectionControls, factory: string): void {
  if (controls === null || typeof controls !== "object" || Array.isArray(controls)) {
    throw new Error(`${factory}: controls must be an object`);
  }
  try {
    assertRegionId(controls.regionId);
  } catch {
    throw new Error(`${factory}: invalid regionId`);
  }
  if (typeof controls.baseHref !== "string") {
    throw new TypeError(`${factory}: controls.baseHref must be a string`);
  }
  if (controls.search !== undefined) {
    if (
      controls.search === null ||
      typeof controls.search !== "object" ||
      typeof controls.search.query !== "string"
    ) {
      throw new Error(`${factory}: controls.search.query must be a string`);
    }
  }
  if (controls.filters !== undefined) {
    if (!Array.isArray(controls.filters)) {
      throw new Error(`${factory}: controls.filters must be an array`);
    }
    controls.filters.forEach((condition, index) => assertFilter(condition, index));
  }
  if (controls.order !== undefined) {
    if (!Array.isArray(controls.order)) {
      throw new Error(`${factory}: controls.order must be an array`);
    }
    controls.order.forEach((selector, index) => assertOrder(selector, index));
  }
  if (controls.pagination !== undefined) {
    const pagination = controls.pagination;
    if (pagination === null || typeof pagination !== "object" || Array.isArray(pagination)) {
      throw new Error(`${factory}: controls.pagination must be an object`);
    }
    if (pagination.nextCursor !== undefined && typeof pagination.nextCursor !== "string") {
      throw new Error(`${factory}: controls.pagination.nextCursor must be a string`);
    }
    if (pagination.prevCursor !== undefined && typeof pagination.prevCursor !== "string") {
      throw new Error(`${factory}: controls.pagination.prevCursor must be a string`);
    }
  }
  if (controls.exportHref !== undefined && typeof controls.exportHref !== "string") {
    throw new TypeError(`${factory}: controls.exportHref must be a string`);
  }
  if (controls.printHref !== undefined && typeof controls.printHref !== "string") {
    throw new TypeError(`${factory}: controls.printHref must be a string`);
  }
}

/**
 * Closed control-URL builder: serializes only q, f[n][field|op|value|upper],
 * o[n][field|dir] and cursor, all percent-encoded, onto the dispatcher
 * baseHref (existing query/fragment preserved). Malformed state throws; a
 * hostile baseHref falls back to "#". Empty q/cursor are omitted.
 */
export function controlHref(baseHref: string, state: ControlQueryState = {}): string {
  if (typeof baseHref !== "string") {
    throw new TypeError("controlHref baseHref must be a string");
  }
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("controlHref state must be an object");
  }
  const { q, filters, order, cursor } = state;
  if (q !== undefined && typeof q !== "string") {
    throw new Error("controlHref q must be a string");
  }
  if (cursor !== undefined && typeof cursor !== "string") {
    throw new Error("controlHref cursor must be a string");
  }
  if (filters !== undefined && !Array.isArray(filters)) {
    throw new Error("controlHref filters must be an array");
  }
  if (order !== undefined && !Array.isArray(order)) {
    throw new Error("controlHref order must be an array");
  }
  if (!isSafeUrl(baseHref)) {
    return "#";
  }
  const params = new URLSearchParams();
  if (q !== undefined && q !== "") {
    params.append("q", q);
  }
  for (const [index, condition] of (filters ?? []).entries()) {
    assertFilter(condition, index);
    params.append(`f[${String(index)}][field]`, condition.field);
    params.append(`f[${String(index)}][op]`, condition.op);
    if (condition.value !== undefined) {
      params.append(`f[${String(index)}][value]`, scalarText(condition.value, "filter value"));
    }
    if (condition.upper !== undefined) {
      params.append(`f[${String(index)}][upper]`, scalarText(condition.upper, "filter upper"));
    }
  }
  for (const [index, selector] of (order ?? []).entries()) {
    assertOrder(selector, index);
    params.append(`o[${String(index)}][field]`, selector.field);
    params.append(`o[${String(index)}][dir]`, selector.direction);
  }
  if (cursor !== undefined && cursor !== "") {
    params.append("cursor", cursor);
  }
  const query = params.toString();
  const hash = baseHref.indexOf("#");
  const path = hash === -1 ? baseHref : baseHref.slice(0, hash);
  const fragment = hash === -1 ? "" : baseHref.slice(hash);
  const built = query === "" ? path : `${path}${path.includes("?") ? "&" : "?"}${query}`;
  return safeHref(`${built}${fragment}`);
}

/**
 * hx-get anchor targeting the collection region with a morph swap. Request
 * attributes come from the shared hxAttrs builder so the swap vocabulary
 * stays single-sourced (morph renders as outerMorph); the visible href is
 * the same controlHref output, already safe.
 */
function regionLink(href: string, regionId: string, label: string, extra: string): string {
  const attrs = hxAttrs({ method: "get", href, target: `#${regionId}`, swap: "morph" });
  return `<a href="${escapeAttr(href)}" ${attrs}${extra}>${label}</a>`;
}

/** Chip text for one accepted condition: `field op value`, text only. */
function chipText(
  condition: FilterCondition,
  context: PresentationContext,
): string {
  const field = escapeHtml(condition.field);
  switch (condition.op) {
    case "between":
      return (
        `${field} ${escapeHtml(condition.op)} ` +
        `${escapeHtml(scalarText(condition.value, "filter value"))} ` +
        `${escapeHtml(resolveCaption(BETWEEN_AND, context))} ` +
        `${escapeHtml(scalarText(condition.upper, "filter upper"))}`
      );
    case "is_null":
    case "not_null":
      return `${field} ${escapeHtml(condition.op)}`;
    default:
      return (
        `${field} ${escapeHtml(condition.op)} ` +
        `${escapeHtml(scalarText(condition.value, "filter value"))}`
      );
  }
}

/**
 * daisyUI query-state toolbar: debounced search input, one removable chip
 * per active filter, readonly order chips plus a select over exactly the
 * accepted selectors. Every control GETs the dispatcher baseHref against
 * the collection region; a changed query/filter/order restarts pagination
 * (no cursor is carried). The select submits a single `order` param valued
 * `<field> <direction>` (the dispatcher resolves it against the accepted
 * selectors); no other option shape is emitted.
 */
export async function collectionToolbar(controls: CollectionControls): Promise<string> {
  assertControls(controls, "collectionToolbar");
  const query = controls.search?.query ?? "";
  const filters = controls.filters ?? [];
  const order = controls.order ?? [];
  const searchHref = controlHref(controls.baseHref, {
    ...(filters.length === 0 ? {} : { filters }),
    ...(order.length === 0 ? {} : { order }),
  });
  const searchLabel = escapeHtml(resolveCaption(SEARCH_LABEL, controls.context));
  const searchId = `${controls.regionId}-q`;
  const searchAttrs = hxAttrs({
    method: "get",
    href: searchHref,
    target: `#${controls.regionId}`,
    swap: "morph",
    trigger: "input changed delay:500ms, keyup[key=='Enter']",
    include: "this",
  });
  const search =
    `<label class="sr-only" for="${escapeAttr(searchId)}">${searchLabel}</label>` +
    `<input id="${escapeAttr(searchId)}" class="input input-sm" type="search" name="q" ` +
    `value="${escapeAttr(query)}" ${searchAttrs}>`;
  const chips = filters.map((condition, index) => {
    const rest = filters.filter((_, other) => other !== index);
    const href = controlHref(controls.baseHref, {
      ...(query === "" ? {} : { q: query }),
      ...(rest.length === 0 ? {} : { filters: rest }),
      ...(order.length === 0 ? {} : { order }),
    });
    const removeLabel = escapeHtml(resolveCaption(REMOVE_FILTER_LABEL, controls.context));
    return (
      `<span class="badge badge-lg gap-2" data-chip>${chipText(condition, controls.context)}` +
      regionLink(href, controls.regionId, "×", ` aria-label="${removeLabel}"`) +
      `</span>`
    );
  });
  const orderBase = {
    ...(query === "" ? {} : { q: query }),
    ...(filters.length === 0 ? {} : { filters }),
  };
  const orderLabel = escapeHtml(resolveCaption(ORDER_LABEL, controls.context));
  const orderLinks = order.map((selector, index) => {
    const text = `${selector.field} ${selector.direction}`;
    if (order.length < 2) {
      return `<span class="badge" data-order-chip>${escapeHtml(text)}</span>`;
    }
    const rotated = [selector, ...order.filter((_, other) => other !== index)];
    const href = controlHref(controls.baseHref, { ...orderBase, order: rotated });
    return regionLink(
      href,
      controls.regionId,
      escapeHtml(text),
      ` class="badge" data-order-chip aria-label="${orderLabel}: ${escapeAttr(text)}"`,
    );
  });
  return `<div class="flex gap-2" data-toolbar role="search">${search}${chips.join("")}${orderLinks.join("")}</div>`;
}

/**
 * Opaque-cursor pagination: prev/next hx-get links preserving the accepted
 * query/filter/order state, or disabled buttons when the cursor is absent.
 * Cursors are percent-encoded verbatim, never decoded or inspected. Absent
 * pagination state renders nothing.
 */
export async function collectionPagination(controls: CollectionControls): Promise<string> {
  assertControls(controls, "collectionPagination");
  if (controls.pagination === undefined) {
    return "";
  }
  const query = controls.search?.query ?? "";
  const filters = controls.filters ?? [];
  const order = controls.order ?? [];
  const pageHref = (cursor: string): string =>
    controlHref(controls.baseHref, {
      ...(query === "" ? {} : { q: query }),
      ...(filters.length === 0 ? {} : { filters }),
      ...(order.length === 0 ? {} : { order }),
      cursor,
    });
  const prevLabel = escapeHtml(resolveCaption(PREV_LABEL, controls.context));
  const nextLabel = escapeHtml(resolveCaption(NEXT_LABEL, controls.context));
  const prev =
    controls.pagination.prevCursor === undefined || controls.pagination.prevCursor === ""
      ? `<button class="join-item btn btn-disabled" disabled aria-disabled="true">${prevLabel}</button>`
      : regionLink(
          pageHref(controls.pagination.prevCursor),
          controls.regionId,
          prevLabel,
          ` class="join-item btn"`,
        );
  const next =
    controls.pagination.nextCursor === undefined || controls.pagination.nextCursor === ""
      ? `<button class="join-item btn btn-disabled" disabled aria-disabled="true">${nextLabel}</button>`
      : regionLink(
          pageHref(controls.pagination.nextCursor),
          controls.regionId,
          nextLabel,
          ` class="join-item btn"`,
        );
  return `<div class="join" data-pagination>${prev}${next}</div>`;
}

/**
 * Plain navigation link to the dispatcher export target. Exports may be
 * async jobs, so this is never a download attribute or an hx request; an
 * absent href omits the control and a hostile one falls back to "#".
 */
export async function collectionExportLink(controls: CollectionControls): Promise<string> {
  assertControls(controls, "collectionExportLink");
  if (controls.exportHref === undefined) {
    return "";
  }
  const label = escapeHtml(resolveCaption(EXPORT_LABEL, controls.context));
  return `<a class="btn btn-sm" data-export href="${escapeAttr(safeHref(controls.exportHref))}">${label}</a>`;
}

/** Plain navigation link to the dispatcher print target; see export. */
export async function collectionPrintLink(controls: CollectionControls): Promise<string> {
  assertControls(controls, "collectionPrintLink");
  if (controls.printHref === undefined) {
    return "";
  }
  const label = escapeHtml(resolveCaption(PRINT_LABEL, controls.context));
  return `<a class="btn btn-sm" data-print href="${escapeAttr(safeHref(controls.printHref))}">${label}</a>`;
}

/**
 * Export + print share row. Renders nothing when both hrefs are absent;
 * either link alone renders without the other.
 */
export async function collectionShareControls(controls: CollectionControls): Promise<string> {
  const exportLink = await collectionExportLink(controls);
  const printLink = await collectionPrintLink(controls);
  if (exportLink === "" && printLink === "") {
    return "";
  }
  return `<div class="flex gap-2" data-share>${exportLink}${printLink}</div>`;
}

/** True when a search query or at least one filter narrows the rows. */
function hasActiveQuery(controls: CollectionControls): boolean {
  const query = controls.search?.query;
  if (typeof query === "string" && query !== "") {
    return true;
  }
  return (controls.filters?.length ?? 0) > 0;
}

/**
 * Filtered-empty ("no-match") block with a clear-filters link to the bare
 * baseHref. Rendered inline (rather than renderState's plain no-match
 * paragraph) so the clear-filters affordance stays with the message.
 */
async function noMatchBlock(controls: CollectionControls): Promise<string> {
  const bare = controlHref(controls.baseHref);
  const note = escapeHtml(resolveCaption(NO_MATCH_NOTE, controls.context));
  const clear = escapeHtml(resolveCaption(CLEAR_LABEL, controls.context));
  return (
    `<div data-no-match><p>${note}</p>` +
    regionLink(bare, controls.regionId, clear, ` class="btn btn-sm"`) +
    `</div>`
  );
}

/** Zero-row body with controls: no-match under active query, else empty. */
async function emptyBody(
  controls: CollectionControls,
  props: Pick<ListProps, "context" | "empty">,
): Promise<string> {
  if (hasActiveQuery(controls)) {
    return noMatchBlock(controls);
  }
  return renderState({ context: props.context, kind: "empty", message: props.empty });
}

/**
 * Rows and toolbar captions must resolve under one effective locale/theme:
 * generated code passes a single context; a divergent controls context is a
 * caller bug that would otherwise render mixed-locale output. Throws.
 */
function assertConsistentContext(
  outer: PresentationContext,
  inner: PresentationContext,
  factory: string,
): void {
  const fingerprint = (context: PresentationContext): string =>
    JSON.stringify({
      locales: context.preferredLocales,
      def: context.appDefaultLocale,
      theme: context.theme,
    });
  if (fingerprint(outer) !== fingerprint(inner)) {
    throw new Error(`${factory}: controls context diverges from collection context`);
  }
}

/**
 * Wrap rows chrome in the canonical automatic collection region via
 * fragmentRegion (stable id, morph default, aria-label): toolbar, body,
 * pagination, share controls. Pagination replaces the S3 more-note here;
 * the runner cursor still flows through controls.pagination server-side.
 */
async function wrapWithControls(
  controls: CollectionControls,
  bodyHtml: string,
  props: Pick<ListProps, "model">,
): Promise<string> {
  const label: MessageValue = controls.label ?? props.model;
  const toolbar = await collectionToolbar(controls);
  const pagination = await collectionPagination(controls);
  const share = await collectionShareControls(controls);
  return fragmentRegion({
    context: controls.context,
    regionId: controls.regionId,
    content: [toolbar, bodyHtml, pagination, share],
    label,
  });
}

// ---------------------------------------------------------------------------
// C7 collection factories: board, csvImport.
//
// Pure async string builders (no h(), hydration or client state). Props live
// in the presentation contract. Both route appearance through
// appearanceClasses() under their exact catalog id; neither word admits an
// appearance matrix, so any token throws.
// ---------------------------------------------------------------------------

/**
 * Enum-grouped board: one section per group (stable order), one card per
 * row. Cards reuse the shared rowHeading label rule and the table cell
 * contract (renderCell), so formatting matches tables exactly. Group order
 * follows the `by` column's valueLabels declaration order when present
 * (cases without rows still render an empty group); otherwise groups appear
 * in first-seen row order. Missing/non-string group values and values
 * outside a declared valueLabels universe throw. No drag/drop affordances.
 */
export async function board(props: BoardProps): Promise<string> {
  // board admits no appearance matrix: any runtime appearance key throws.
  appearanceClasses("board", "board", pickAppearance(props));
  if (typeof props.by !== "string" || props.by === "") {
    throw new Error("board: by must be a nonempty field name");
  }
  if (props.controls !== undefined) {
    assertControls(props.controls, "board");
    assertConsistentContext(props.context, props.controls.context, "board");
  }
  const result = await props.context.query(
    props.context.invocation,
    props.model,
    queryArgs(props, "board"),
  );
  const byField = new Map<string, ColumnMeta>();
  for (const column of result.columns) {
    byField.set(column.field, column);
  }
  const byMeta = byField.get(props.by);
  if (byMeta === undefined) {
    throw new Error(`board "${props.model}": missing group field: ${props.by}`);
  }
  if (!isEnumTypeId(byMeta.type)) {
    throw new Error(
      `board "${props.model}": group field "${props.by}" needs an enum type, got ${JSON.stringify(byMeta.type)}`,
    );
  }
  const missing = props.columns.filter((field) => !byField.has(field));
  if (missing.length > 0) {
    throw new Error(`board "${props.model}": missing columns: ${missing.join(", ")}`);
  }
  if (result.rows.length === 0) {
    if (props.controls === undefined) {
      return renderState({ context: props.context, kind: "empty", message: props.empty });
    }
    return wrapWithControls(props.controls, await emptyBody(props.controls, props), props);
  }
  const metas: ColumnMeta[] = [];
  for (const field of props.columns) {
    const meta = byField.get(field);
    if (meta === undefined) {
      // Unreachable: missing fields threw above.
      throw new Error(`board "${props.model}": missing columns: ${field}`);
    }
    metas.push(meta);
  }
  const labels = byMeta.valueLabels;
  const groups = new Map<string, RowView[]>();
  if (labels !== undefined) {
    for (const key of Object.keys(labels)) {
      groups.set(key, []);
    }
  }
  for (const row of result.rows) {
    const value = row.fields[props.by];
    if (typeof value !== "string" || value === "") {
      throw new Error(
        `board "${props.model}": row "${row.id}" needs a group value for "${props.by}"`,
      );
    }
    if (labels !== undefined && labels[value] === undefined) {
      throw new Error(
        `board "${props.model}": row "${row.id}" has unknown group ${JSON.stringify(value)} for "${props.by}"`,
      );
    }
    const bucket = groups.get(value);
    if (bucket === undefined) {
      groups.set(value, [row]);
    } else {
      bucket.push(row);
    }
  }
  const sections = [...groups.entries()]
    .map(([key, rows]) => {
      const labeled = labels?.[key];
      const heading = escapeHtml(
        labeled === undefined ? key : resolveCaption(labeled, props.context),
      );
      const cards = rows.map((row) => boardCard(row, metas, props)).join("");
      return `<section data-group="${escapeAttr(key)}"><h2>${heading}</h2><ul>${cards}</ul></section>`;
    })
    .join("");
  const boardHtml = `<div class="flex gap-4">${sections}</div>`;
  if (props.controls === undefined) {
    return `${boardHtml}${moreNote(props.context, result.nextCursor)}`;
  }
  return wrapWithControls(props.controls, boardHtml, props);
}

/** One board card: rowHeading title plus one labeled paragraph per column. */
function boardCard(
  row: RowView,
  metas: readonly ColumnMeta[],
  props: BoardProps,
): string {
  const heading = isolate(rowHeading(row, props.model, props.context));
  const lines = metas
    .map((meta) => {
      const label = escapeHtml(resolveCaption(meta.label, props.context));
      return `<p><span>${label}</span> ${renderCell(meta, row.fields[meta.field], props.context)}</p>`;
    })
    .join("");
  return (
    `<li data-row="${escapeAttr(row.id)}">` +
    `<section class="card bg-base-100 shadow"><div class="card-body">` +
    `<h3 class="card-title">${heading}</h3>${lines}</div></section></li>`
  );
}

/** csvImport chrome (ui.csvImport.*): en source + nl variant. */
const CSV_FILE_LABEL = message("CSV file", { nl: "CSV-bestand" });
const CSV_UPLOAD_LABEL = message("Upload", { nl: "Uploaden" });
const CSV_REVIEW_LABEL = message("Preview", { nl: "Preview" });

/**
 * Multipart CSV upload panel POSTing to the caller-supplied postTo path
 * (the themeController honesty rule: a missing path throws, a hostile one
 * falls back to "#" via safeHref, nothing is ever invented). The optional
 * review section renders parsed preview rows with csvFormulaProtect
 * applied; a present-but-empty preview throws rather than rendering an
 * empty table.
 */
export async function csvImport(props: CsvImportProps): Promise<string> {
  // csv-import admits no appearance matrix: any runtime token throws.
  appearanceClasses("csv-import", "csv-import", pickAppearance(props));
  if (typeof props.postTo !== "string" || props.postTo.trim() === "") {
    throw new Error("csvImport needs a non-empty postTo");
  }
  const label = resolveCaption(props.label, props.context);
  if (label === "") {
    throw new Error("csvImport label must not be empty");
  }
  const review = props.review === undefined ? "" : renderCsvReview(props);
  return (
    `<section><h2>${escapeHtml(label)}</h2>` +
    `<form action="${escapeAttr(safeHref(props.postTo))}" method="post" enctype="multipart/form-data">` +
    `<input type="hidden" name="${escapeAttr(CSRF_FIELD)}" value="${escapeAttr(props.context.csrfToken)}">` +
    `<label>${escapeHtml(resolveCaption(CSV_FILE_LABEL, props.context))}` +
    `<input type="file" name="file" accept=".csv,text/csv" class="file-input"></label>` +
    `<button type="submit" class="btn btn-primary">${escapeHtml(resolveCaption(CSV_UPLOAD_LABEL, props.context))}</button>` +
    `</form>${review}</section>`
  );
}

/** Preview table over caller-parsed rows; every cell is armored + escaped. */
function renderCsvReview(props: CsvImportProps): string {
  const review = props.review as CsvImportReview;
  if (review === null || typeof review !== "object" || Array.isArray(review)) {
    throw new Error("csvImport review must be an object");
  }
  if (!Array.isArray(review.columns) || review.columns.length === 0) {
    throw new Error("csvImport review needs nonempty columns");
  }
  if (!Array.isArray(review.rows) || review.rows.length === 0) {
    throw new Error("csvImport review needs a nonempty preview");
  }
  const width = review.columns.length;
  const head = review.columns
    .map((column) => `<th scope="col">${escapeHtml(resolveCaption(column, props.context))}</th>`)
    .join("");
  const body = review.rows
    .map((cells, index) => {
      if (!Array.isArray(cells) || cells.length !== width) {
        throw new Error(
          `csvImport review row ${String(index)} needs exactly ${String(width)} cells`,
        );
      }
      const rendered = cells
        .map((cell) => {
          if (typeof cell !== "string") {
            throw new Error(`csvImport review row ${String(index)} cells must be strings`);
          }
          return `<td>${isolate(escapeHtml(csvFormulaProtect(cell)))}</td>`;
        })
        .join("");
      return `<tr>${rendered}</tr>`;
    })
    .join("");
  const heading = escapeHtml(resolveCaption(CSV_REVIEW_LABEL, props.context));
  return (
    `<section><h3>${heading}</h3>` +
    `<table class="table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`
  );
}
