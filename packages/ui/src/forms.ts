/**
 * Canonical bound forms (S4): create/update forms, edit/delete controls,
 * single actions and action groups.
 *
 * Every factory renders a plain POST form carrying hidden operation,
 * operation_id, CSRF and timezone fields. Field widgets follow the lane 2
 * CanTypeId vocabulary and render drafts verbatim (never reformatted, never
 * lossy). Field errors map from JSON-pointer paths to input names; unmatched
 * errors and mutation outcomes render as top banners so nothing is dropped.
 * Internal chrome wording follows the shell.ts pattern (en source + nl
 * variants through message()/resolveCaption).
 */

import { CSRF_FIELD } from "../../contracts/src/presentation.js";
import type {
  ActionProps,
  ActionsProps,
  DeleteProps,
  EditProps,
  FormFieldDef,
  FormMode,
  FormOutcome,
  FormProps,
  MessageValue,
  PresentationContext,
} from "../../contracts/src/presentation.js";
import type { FieldError, MutationRef } from "../../contracts/src/presentation.js";
import { escapeAttr, escapeHtml, safeHref } from "./escape.js";
import {
  canonicalDefaultTag,
  canonicalPreferredTags,
  formatScalar,
  isEnumTypeId,
  message,
  resolveCaption,
} from "./messages.js";

/**
 * Form chrome wording, en source + nl variants. Follows the shell.ts CHROME
 * pattern; entries move to the shared runtime catalog when it lands.
 */
const CHROME = {
  cancel: message("Cancel", { nl: "Annuleren" }),
  deleteSubmit: message("Delete", { nl: "Verwijderen" }),
  archiveSubmit: message("Archive", { nl: "Archiveren" }),
  retryHint: message("You can retry.", { nl: "U kunt het opnieuw proberen." }),
  pendingLead: message("Deliveries are still pending.", {
    nl: "Leveringen zijn nog in behandeling.",
  }),
  unknownLead: message("The outcome is unknown. Reconcile this operation before retrying:", {
    nl: "De uitkomst is onbekend. Stem deze operatie af voordat u het opnieuw probeert:",
  }),
  unmatchedLead: message("There were problems with your submission.", {
    nl: "Er waren problemen met uw inzending.",
  }),
  conflictField: message("Field", { nl: "Veld" }),
  conflictCurrent: message("Current value", { nl: "Huidige waarde" }),
  statusPending: message("Pending", { nl: "In behandeling" }),
  statusSucceeded: message("Succeeded", { nl: "Geslaagd" }),
  statusFailed: message("Failed", { nl: "Mislukt" }),
  statusUnknown: message("Unknown", { nl: "Onbekend" }),
  statusSkipped: message("Skipped", { nl: "Overgeslagen" }),
} as const;

const STATUS_LABELS: Record<string, MessageValue> = {
  pending: CHROME.statusPending,
  succeeded: CHROME.statusSucceeded,
  failed: CHROME.statusFailed,
  unknown: CHROME.statusUnknown,
  skipped: CHROME.statusSkipped,
};

const STATUS_TONES: Record<string, string> = {
  pending: "badge-warning",
  succeeded: "badge-success",
  failed: "badge-error",
  unknown: "badge-ghost",
  skipped: "badge-ghost",
};

const FIELD_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INT_RE = /^[+-]?\d+$/;
const DECIMAL_RE = /^[+-]?(?:\d+)(?:\.\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?$/;

/** String-valued scalar input types (input, or textarea when multiline). */
const TEXT_TYPES = new Set(["text", "email", "url", "timezone", "locale", "currency"]);

/**
 * Map a JSON Pointer into the submitted inputs (e.g. "/changes/title") to
 * its bracket form name (e.g. "inputs[changes][title]"). Handles RFC 6901
 * `~0`/`~1` escapes; anything else malformed throws.
 */
export function pointerToFieldName(pointer: string): string {
  if (typeof pointer !== "string") {
    throw new TypeError("pointerToFieldName: pointer must be a string");
  }
  if (pointer === "" || !pointer.startsWith("/")) {
    throw new Error(`malformed JSON pointer ${JSON.stringify(pointer)}: must start with "/"`);
  }
  const segments: string[] = [];
  for (const raw of pointer.split("/").slice(1)) {
    if (raw === "") {
      throw new Error(`malformed JSON pointer ${JSON.stringify(pointer)}: empty segment`);
    }
    segments.push(unescapeSegment(raw, pointer));
  }
  return `inputs${segments.map((segment) => `[${segment}]`).join("")}`;
}

function unescapeSegment(segment: string, pointer: string): string {
  let out = "";
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment.charAt(i);
    if (ch !== "~") {
      out += ch;
      continue;
    }
    const next = segment.charAt(i + 1);
    if (next === "0") {
      out += "~";
      i += 1;
    } else if (next === "1") {
      out += "/";
      i += 1;
    } else {
      throw new Error(
        `malformed JSON pointer ${JSON.stringify(pointer)}: bad escape in segment ${JSON.stringify(segment)}`,
      );
    }
  }
  return out;
}

/**
 * Render a canonical RFC3339 UTC instant as a datetime-local wall time
 * ("YYYY-MM-DDTHH:mm") in the given time zone. Rejects rolled-over
 * dates/times like messages.ts; an invalid time zone throws the Intl
 * RangeError, which propagates to the caller.
 */
export function formatDatetimeLocal(instant: string, timeZone: string): string {
  if (typeof instant !== "string") {
    throw new TypeError("formatDatetimeLocal: instant must be a string");
  }
  if (typeof timeZone !== "string") {
    throw new TypeError("formatDatetimeLocal: timeZone must be a string");
  }
  if (
    !DATETIME_RE.test(instant) ||
    !isValidDate(instant.slice(0, 10)) ||
    !TIME_RE.test(instant.slice(11, -1)) ||
    !Number.isFinite(Date.parse(instant))
  ) {
    throw new TypeError(
      `invalid datetime instant ${JSON.stringify(instant)}: expected a canonical RFC3339 UTC instant`,
    );
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (type: string): string => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) {
      throw new Error(`formatDatetimeLocal: missing ${type} part`);
    }
    return found.value;
  };
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

function isValidDate(iso: string): boolean {
  const parts = iso.split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (y === undefined || m === undefined || d === undefined) {
    return false;
  }
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return false;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    return false;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Page locale: first valid viewer preference, else the app default. */
function pageLocale(context: PresentationContext): string {
  const preferred = canonicalPreferredTags(context.preferredLocales);
  return preferred[0] ?? canonicalDefaultTag(context.appDefaultLocale);
}

function assertFieldPath(path: string): void {
  if (typeof path !== "string" || !FIELD_PATH_RE.test(path)) {
    throw new Error(`invalid field path ${JSON.stringify(path)}: must match /^[A-Za-z_][A-Za-z0-9_]*$/`);
  }
}

/** Input root: update writes `inputs[changes][key]`, create/scenario `inputs[key]`. */
function fieldName(mode: FormMode, path: string): string {
  return mode === "update" ? `inputs[changes][${path}]` : `inputs[${path}]`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}">`;
}

function recordHiddens(record: MutationRef | undefined): string {
  if (record === undefined) {
    return "";
  }
  return hidden("inputs[record][id]", record.id) + hidden("inputs[record][version]", record.version);
}

function cancelLink(cancelHref: string | undefined, context: PresentationContext): string {
  if (cancelHref === undefined) {
    return "";
  }
  return `<a class="btn btn-ghost" href="${escapeAttr(safeHref(cancelHref))}">${escapeHtml(resolveCaption(CHROME.cancel, context))}</a>`;
}

/** Serialize one pre-bound action scalar to its hidden-input value. */
function serializeActionScalar(key: string, value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`action input "${key}": number value must be finite`);
    }
    return String(value);
  }
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  throw new TypeError(
    `action input "${key}": unsupported ${actual} value; expected string, number, bigint or boolean`,
  );
}

interface FieldRenderContext {
  readonly context: PresentationContext;
  readonly mode: FormMode;
  readonly timeZone: string;
  readonly idPrefix: string;
  readonly errorsByName: ReadonlyMap<string, readonly FieldError[]>;
}

interface WidgetAttrs {
  readonly nameAttr: string;
  readonly idAttr: string;
  readonly common: string;
}

interface WidgetResult {
  readonly html: string;
  /** Value a readonly hidden duplicate carries (same string the widget shows). */
  readonly submitValue: string;
}

/** Draft-preserving string value: verbatim when present, null when absent. */
function stringFieldValue(field: FormFieldDef): string | null {
  const value = field.value;
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(`field "${field.path}": type ${field.type} needs a string value`);
  }
  return value;
}

function intFieldValue(field: FormFieldDef): string {
  const value = field.value;
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `field "${field.path}": type int needs a bigint, safe number or canonical int string`,
      );
    }
    return String(value);
  }
  if (typeof value === "string" && INT_RE.test(value)) {
    return value;
  }
  throw new TypeError(
    `field "${field.path}": type int needs a bigint, safe number or canonical int string`,
  );
}

function decimalFieldValue(field: FormFieldDef): string {
  const value = field.value;
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (typeof value === "string" && DECIMAL_RE.test(value)) {
    return value;
  }
  throw new TypeError(
    `field "${field.path}": type decimal needs a bigint or canonical decimal string`,
  );
}

function moneyFieldValue(field: FormFieldDef): string {
  const value = field.value;
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `field "${field.path}": type money needs a bigint, safe number or canonical minor-units string`,
      );
    }
    return String(value);
  }
  if (typeof value === "string" && INT_RE.test(value)) {
    return value;
  }
  throw new TypeError(
    `field "${field.path}": type money needs a bigint, safe number or canonical minor-units string`,
  );
}

function boolFieldValue(field: FormFieldDef): boolean {
  const value = field.value;
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(`field "${field.path}": type bool needs a boolean value`);
  }
  return value;
}

function dateFieldValue(field: FormFieldDef): string {
  const value = field.value;
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string" || !DATE_RE.test(value) || !isValidDate(value)) {
    throw new TypeError(`field "${field.path}": type date needs a valid YYYY-MM-DD civil date`);
  }
  return value;
}

function datetimeFieldValue(field: FormFieldDef, timeZone: string): string {
  const value = field.value;
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new TypeError(
      `field "${field.path}": type datetime needs a canonical RFC3339 UTC instant`,
    );
  }
  try {
    return formatDatetimeLocal(value, timeZone);
  } catch (error) {
    throw new Error(`field "${field.path}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

function textWidget(field: FormFieldDef, attrs: WidgetAttrs): WidgetResult {
  const value = stringFieldValue(field) ?? "";
  if (field.multiline === true) {
    return {
      html:
        `<textarea name="${attrs.nameAttr}" id="${attrs.idAttr}" class="textarea"${attrs.common}>` +
        `${escapeHtml(value)}</textarea>`,
      submitValue: value,
    };
  }
  const inputType = field.type === "email" ? "email" : field.type === "url" ? "url" : "text";
  return {
    html:
      `<input type="${inputType}" name="${attrs.nameAttr}" id="${attrs.idAttr}" ` +
      `value="${escapeAttr(value)}" class="input"${attrs.common}>`,
    submitValue: value,
  };
}

function decimalWidget(field: FormFieldDef, attrs: WidgetAttrs): WidgetResult {
  const value =
    field.type === "int"
      ? intFieldValue(field)
      : field.type === "decimal"
        ? decimalFieldValue(field)
        : moneyFieldValue(field);
  return {
    html:
      `<input type="text" inputmode="decimal" name="${attrs.nameAttr}" id="${attrs.idAttr}" ` +
      `value="${escapeAttr(value)}" class="input"${attrs.common}>`,
    submitValue: value,
  };
}

function boolWidget(field: FormFieldDef, attrs: WidgetAttrs): WidgetResult {
  const checked = boolFieldValue(field);
  return {
    html:
      `<input type="checkbox" name="${attrs.nameAttr}" id="${attrs.idAttr}" value="true"` +
      `${checked ? " checked" : ""} class="toggle"${attrs.common}>`,
    submitValue: checked ? "true" : "false",
  };
}

function selectWidget(
  field: FormFieldDef,
  kind: "enum" | "reference",
  attrs: WidgetAttrs,
  context: PresentationContext,
): WidgetResult {
  const options = field.options;
  if (options === undefined) {
    if (kind === "enum") {
      throw new Error(
        `field "${field.path}": enum select for type "${field.type}" needs schema-supplied options`,
      );
    }
    throw new Error(
      `field "${field.path}": reference select for type "${field.type}" needs options (the S5 search picker supplies them)`,
    );
  }
  const current = stringFieldValue(field);
  const items = options
    .map((option) => {
      const label = escapeHtml(resolveCaption(option.label, context));
      const selected = current !== null && option.value === current ? " selected" : "";
      return `<option value="${escapeAttr(option.value)}"${selected}>${label}</option>`;
    })
    .join("");
  return {
    html: `<select name="${attrs.nameAttr}" id="${attrs.idAttr}" class="select"${attrs.common}>${items}</select>`,
    submitValue: current ?? "",
  };
}

function dateWidget(field: FormFieldDef, attrs: WidgetAttrs): WidgetResult {
  const value = dateFieldValue(field);
  return {
    html:
      `<input type="date" name="${attrs.nameAttr}" id="${attrs.idAttr}" ` +
      `value="${escapeAttr(value)}" class="input"${attrs.common}>`,
    submitValue: value,
  };
}

function datetimeWidget(field: FormFieldDef, attrs: WidgetAttrs, timeZone: string): WidgetResult {
  const value = datetimeFieldValue(field, timeZone);
  return {
    html:
      `<input type="datetime-local" name="${attrs.nameAttr}" id="${attrs.idAttr}" ` +
      `value="${escapeAttr(value)}" class="input"${attrs.common}>` +
      `<span>${escapeHtml(timeZone)}</span>`,
    submitValue: value,
  };
}

function renderWidget(
  field: FormFieldDef,
  attrs: WidgetAttrs,
  context: PresentationContext,
  timeZone: string,
): WidgetResult {
  const type = field.type;
  if (typeof type !== "string") {
    throw new TypeError(`field "${field.path}": type must be a string`);
  }
  if (type === "file" || type.startsWith("file.")) {
    throw new Error(`field "${field.path}": file inputs need S7 upload intents (type "${type}")`);
  }
  if (TEXT_TYPES.has(type)) {
    return textWidget(field, attrs);
  }
  if (type === "int" || type === "decimal" || type === "money") {
    return decimalWidget(field, attrs);
  }
  if (type === "bool") {
    return boolWidget(field, attrs);
  }
  if (type === "date") {
    return dateWidget(field, attrs);
  }
  if (type === "datetime") {
    return datetimeWidget(field, attrs, timeZone);
  }
  if (isEnumTypeId(type)) {
    if (type === "enum" || type.startsWith("enum.") || type.startsWith("enum:")) {
      return selectWidget(field, "enum", attrs, context);
    }
    // Qualified identities split by shape: `package.Model` is a model
    // reference (options come from the S5 search picker), while
    // `package.Model.field` is a qualified enum (options come from the owning
    // schema). messages.ts documents the enum shape; model names follow the
    // qualified `package.Model` spelling row queries use.
    const segments = type.split(".");
    if (segments.length < 2 || segments.some((segment) => !FIELD_PATH_RE.test(segment))) {
      throw new Error(`field "${field.path}": unsupported type "${type}"`);
    }
    if (segments.length === 2) {
      return selectWidget(field, "reference", attrs, context);
    }
    return selectWidget(field, "enum", attrs, context);
  }
  throw new Error(`field "${field.path}": unsupported type "${type}"`);
}

/** One fieldset: label, widget, per-field errors; readonly adds a hidden duplicate. */
function renderField(field: FormFieldDef, ctx: FieldRenderContext): string {
  assertFieldPath(field.path);
  const name = fieldName(ctx.mode, field.path);
  const id = `${ctx.idPrefix}-${field.path}`;
  const idAttr = escapeAttr(id);
  const fieldErrors = ctx.errorsByName.get(name) ?? [];
  const describedBy =
    fieldErrors.length === 0 ? "" : ` aria-describedby="${escapeAttr(`${id}-error`)}"`;
  const invalid = fieldErrors.length === 0 ? "" : ` aria-invalid="true"`;
  const requiredAttr = field.required ? ` aria-required="true"` : "";
  const disabled = field.readonly === true ? " disabled" : "";
  const widget = renderWidget(
    field,
    { nameAttr: escapeAttr(name), idAttr, common: `${requiredAttr}${invalid}${describedBy}${disabled}` },
    ctx.context,
    ctx.timeZone,
  );
  const label = escapeHtml(resolveCaption(field.label, ctx.context));
  const mark = field.required ? ` <span aria-hidden="true">*</span>` : "";
  const errorHtml =
    fieldErrors.length === 0
      ? ""
      : `<div id="${escapeAttr(`${id}-error`)}">${fieldErrors.map((error) => `<p class="text-error">${escapeHtml(error.message)}</p>`).join("")}</div>`;
  const duplicate = field.readonly === true ? hidden(name, widget.submitValue) : "";
  return (
    `<fieldset><label for="${idAttr}" class="label">${label}${mark}</label>` +
    `${widget.html}${errorHtml}${duplicate}</fieldset>`
  );
}

function splitErrors(
  errors: readonly FieldError[] | undefined,
  names: ReadonlySet<string>,
): { matched: Map<string, FieldError[]>; unmatched: FieldError[] } {
  const matched = new Map<string, FieldError[]>();
  const unmatched: FieldError[] = [];
  for (const error of errors ?? []) {
    let name: string;
    try {
      name = pointerToFieldName(error.path);
    } catch {
      unmatched.push(error);
      continue;
    }
    if (names.has(name)) {
      const list = matched.get(name);
      if (list === undefined) {
        matched.set(name, [error]);
      } else {
        list.push(error);
      }
    } else {
      unmatched.push(error);
    }
  }
  return { matched, unmatched };
}

/** Top alert for errors that match no rendered field; every error is listed. */
function unmatchedAlert(errors: readonly FieldError[], context: PresentationContext): string {
  if (errors.length === 0) {
    return "";
  }
  const items = errors
    .map((error) => `<li>${escapeHtml(error.message)} (${escapeHtml(error.code)})</li>`)
    .join("");
  const lead = escapeHtml(resolveCaption(CHROME.unmatchedLead, context));
  return `<div role="alert" class="alert alert-error"><p>${lead}</p><ul>${items}</ul></div>`;
}

/** Current value cell: typed formatScalar, falling back to raw escaped text. */
function formatCurrentValue(
  type: string | undefined,
  value: unknown,
  context: PresentationContext,
  timeZone: string,
): string {
  if (type !== undefined) {
    try {
      const scales = context.currencyScales;
      const text = formatScalar(
        { type, value },
        {
          locale: pageLocale(context),
          timeZone,
          ...(scales === undefined ? {} : { currencyScales: scales }),
        },
      );
      return escapeHtml(text);
    } catch {
      // Fall through to the raw rendering below.
    }
  }
  return escapeHtml(rawText(value));
}

function rawText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Mutation-outcome banner: pending deliveries, conflict currents, failed, unknown. */
function outcomeBanner(
  outcome: FormOutcome | undefined,
  fields: readonly FormFieldDef[],
  context: PresentationContext,
  timeZone: string,
): string {
  if (outcome === undefined) {
    return "";
  }
  switch (outcome.status) {
    case "pending": {
      const items = outcome.deliveries
        .map((delivery) => {
          const known = STATUS_LABELS[delivery.status];
          const text = known === undefined ? delivery.status : resolveCaption(known, context);
          const tone = STATUS_TONES[delivery.status];
          const badge = tone === undefined ? "badge" : `badge ${tone}`;
          return `<li><span>${escapeHtml(delivery.id)}</span> <span class="${badge}">${escapeHtml(text)}</span></li>`;
        })
        .join("");
      const lead = escapeHtml(resolveCaption(CHROME.pendingLead, context));
      return `<div role="status" class="alert alert-info"><p>${lead}</p><ul>${items}</ul></div>`;
    }
    case "conflict": {
      const byPath = new Map<string, FormFieldDef>();
      for (const field of fields) {
        byPath.set(field.path, field);
      }
      const rows = Object.keys(outcome.current)
        .map((key) => {
          const field = byPath.get(key);
          const label =
            field === undefined ? escapeHtml(key) : escapeHtml(resolveCaption(field.label, context));
          const cell = formatCurrentValue(field?.type, outcome.current[key], context, timeZone);
          return `<tr><th scope="row">${label}</th><td>${cell}</td></tr>`;
        })
        .join("");
      const note = escapeHtml(resolveCaption(outcome.message, context));
      const headField = escapeHtml(resolveCaption(CHROME.conflictField, context));
      const headCurrent = escapeHtml(resolveCaption(CHROME.conflictCurrent, context));
      return (
        `<div role="alert" class="alert alert-warning"><p>${note}</p>` +
        `<table class="table"><thead><tr><th scope="col">${headField}</th>` +
        `<th scope="col">${headCurrent}</th></tr></thead><tbody>${rows}</tbody></table></div>`
      );
    }
    case "failed": {
      const retry =
        outcome.error.retryable === true
          ? `<p>${escapeHtml(resolveCaption(CHROME.retryHint, context))}</p>`
          : "";
      return (
        `<div role="alert" class="alert alert-error">` +
        `<p>${escapeHtml(outcome.error.message)}</p>` +
        `<p><code>${escapeHtml(outcome.error.code)}</code></p>` +
        retry +
        `</div>`
      );
    }
    case "unknown": {
      const note = escapeHtml(resolveCaption(CHROME.unknownLead, context));
      const detail = escapeHtml(resolveCaption(outcome.message, context));
      return (
        `<div role="alert" class="alert alert-warning">` +
        `<p>${note} <code>${escapeHtml(outcome.operationId)}</code></p>` +
        `<p>${detail}</p>` +
        `</div>`
      );
    }
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unsupported form outcome: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Canonical bound form. Renders hidden operation/operation_id/CSRF/timezone
 * fields (plus the bound record), one fieldset per field, and the submit
 * row. Update mode requires a record; field paths must be identifiers.
 */
export async function form(props: FormProps): Promise<string> {
  if (props.mode === "update" && props.record === undefined) {
    throw new Error("form: update mode requires a bound record");
  }
  for (const field of props.fields) {
    assertFieldPath(field.path);
  }
  const names = new Set<string>();
  for (const field of props.fields) {
    names.add(fieldName(props.mode, field.path));
  }
  const { matched, unmatched } = splitErrors(props.errors, names);
  const fieldCtx: FieldRenderContext = {
    context: props.context,
    mode: props.mode,
    timeZone: props.timeZone,
    idPrefix: props.idPrefix,
    errorsByName: matched,
  };
  const fieldsHtml = props.fields.map((field) => renderField(field, fieldCtx)).join("");
  const submitLabel = escapeHtml(resolveCaption(props.submit, props.context));
  return (
    `<form action="${escapeAttr(safeHref(props.action))}" method="post">` +
    hidden("operation", props.operation) +
    hidden("operation_id", props.operationId) +
    hidden(CSRF_FIELD, props.context.csrfToken) +
    hidden("timezone", props.timeZone) +
    recordHiddens(props.record) +
    outcomeBanner(props.outcome, props.fields, props.context, props.timeZone) +
    unmatchedAlert(unmatched, props.context) +
    fieldsHtml +
    `<div class="flex gap-4"><button type="submit" class="btn btn-primary">${submitLabel}</button>${cancelLink(props.cancelHref, props.context)}</div>` +
    `</form>`
  );
}

/** Canonical update control: form() in update mode with its bound record. */
export async function edit(props: EditProps): Promise<string> {
  return form({ ...props, mode: "update", record: props.record });
}

/**
 * Archive/remove confirmation card: item heading, confirm copy, and a POST
 * form carrying the record, operation, CSRF token and mode.
 */
export async function deleteRecord(props: DeleteProps): Promise<string> {
  const heading = escapeHtml(resolveCaption(props.itemLabel, props.context));
  const copy = escapeHtml(resolveCaption(props.confirm, props.context));
  const tone = props.mode === "remove" ? "btn-error" : "btn-warning";
  const submitLabel = escapeHtml(
    resolveCaption(
      props.mode === "remove" ? CHROME.deleteSubmit : CHROME.archiveSubmit,
      props.context,
    ),
  );
  return (
    `<section class="card bg-base-100 shadow"><div class="card-body">` +
    `<h2 class="card-title">${heading}</h2>` +
    `<p>${copy}</p>` +
    `<form action="${escapeAttr(safeHref(props.action))}" method="post">` +
    hidden("operation", props.operation) +
    hidden("operation_id", props.operationId) +
    hidden(CSRF_FIELD, props.context.csrfToken) +
    hidden("timezone", props.timeZone ?? "UTC") +
    recordHiddens(props.record) +
    hidden("inputs[mode]", props.mode) +
    `<div class="flex gap-4"><button type="submit" class="btn ${tone}">${submitLabel}</button>${cancelLink(props.cancelHref, props.context)}</div>` +
    `</form></div></section>`
  );
}

/**
 * Single bound operation: a mini scenario form when fields are present, else
 * a single-button form. Pre-bound record, sealed handle and scalar inputs
 * travel as hidden fields; confirm copy renders above the submit button.
 */
export async function action(props: ActionProps): Promise<string> {
  // The rendering timezone is always declared so the server interprets
  // datetime inputs unambiguously; UTC when the caller supplies none.
  const timeZone = props.timeZone ?? "UTC";
  let extras = hidden("timezone", timeZone);
  extras += recordHiddens(props.record);
  if (props.actionHandle !== undefined) {
    const json = JSON.stringify(props.actionHandle);
    if (json === undefined) {
      throw new TypeError("action: action_handle must be JSON-serializable");
    }
    extras += hidden("action_handle", json);
  }
  if (props.inputs !== undefined) {
    for (const key of Object.keys(props.inputs)) {
      assertFieldPath(key);
      extras += hidden(`inputs[${key}]`, serializeActionScalar(key, props.inputs[key]));
    }
  }
  let fieldsHtml = "";
  let errorsHtml = "";
  if (props.fields !== undefined) {
    for (const field of props.fields) {
      assertFieldPath(field.path);
    }
    const names = new Set<string>();
    for (const field of props.fields) {
      names.add(fieldName("scenario", field.path));
    }
    const { matched, unmatched } = splitErrors(props.errors, names);
    const fieldCtx: FieldRenderContext = {
      context: props.context,
      mode: "scenario",
      timeZone,
      idPrefix: props.idPrefix,
      errorsByName: matched,
    };
    fieldsHtml = props.fields.map((field) => renderField(field, fieldCtx)).join("");
    errorsHtml = unmatchedAlert(unmatched, props.context);
  } else if (props.errors !== undefined) {
    errorsHtml = unmatchedAlert(props.errors, props.context);
  }
  const confirm =
    props.confirm === undefined
      ? ""
      : `<p>${escapeHtml(resolveCaption(props.confirm, props.context))}</p>`;
  const tone =
    props.variant === "danger" ? "btn-error" : props.variant === "ghost" ? "btn-ghost" : "btn-primary";
  const label = escapeHtml(resolveCaption(props.label, props.context));
  return (
    `<form action="${escapeAttr(safeHref(props.action))}" method="post">` +
    hidden("operation", props.operation) +
    hidden("operation_id", props.operationId) +
    hidden(CSRF_FIELD, props.context.csrfToken) +
    extras +
    errorsHtml +
    fieldsHtml +
    confirm +
    `<div class="flex gap-4"><button type="submit" class="btn ${tone}">${label}</button></div>` +
    `</form>`
  );
}

/** Grouped bound operations: each action renders as its own form. */
export async function actions(props: ActionsProps): Promise<string> {
  const parts: string[] = [];
  for (const item of props.actions) {
    parts.push(await action({ ...item, context: props.context }));
  }
  return `<div class="flex gap-2">${parts.join("")}</div>`;
}
