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

import {
  CSRF_FIELD,
  GENERATED_FORM_TYPE_FOR_KIND,
  GENERATED_REF_VERSION_SUFFIX,
} from "@canlang/contracts";
import {
  isValidDate,
  stringFieldValue,
  intFieldValue,
  decimalFieldValue,
  moneyFieldValue,
  boolFieldValue,
  dateFieldValue,
  rawText,
} from "./internal/draft-values.js";
import type {
  ActionProps,
  ActionsProps,
  DeleteProps,
  EditProps,
  FormFieldDef,
  FormMode,
  FormOutcome,
  FormProps,
  GeneratedFormOverrides,
  GeneratedFormProps,
  MessageValue,
  PresentationContext,
} from "@canlang/contracts";
import type { FieldError, MutationRef } from "@canlang/contracts";
import type {
  ClosedInputs,
  DerivedDeliveryBinding,
  DerivedOperationInputs,
  DerivedWritableInput,
} from "@canlang/contracts";
import { escapeAttr, escapeHtml, safeHref } from "./escape.js";
import { drawer } from "./overlays.js";
// C4b explicit-control dispatch + label/validator fragment reuse. This is a
// forms<->controls import cycle, safe under ESM: both modules touch the
// other's bindings only inside render-time function bodies, never at module
// evaluation (all cross-imports are hoisted function declarations).
import {
  calendar,
  checkbox,
  fileInput,
  filter,
  input,
  label,
  otp,
  radio,
  range,
  rating,
  select,
  textarea,
  toggle,
  validator,
} from "./controls.js";
import {
  canonicalDefaultTag,
  canonicalPreferredTags,
  formatMoneyExact,
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
  attachedLead: message("Attached file", { nl: "Bijgevoegd bestand" }),
  deliveryLead: message("Engine-resolved receipt", {
    nl: "Door de engine bepaalde ontvangst",
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

/** Page locale: first valid viewer preference, else the app default. */
function pageLocale(context: PresentationContext): string {
  const preferred = canonicalPreferredTags(context.preferredLocales);
  return preferred[0] ?? canonicalDefaultTag(context.appDefaultLocale);
}

export function assertFieldPath(path: string): void {
  if (typeof path !== "string" || !FIELD_PATH_RE.test(path)) {
    throw new Error(`invalid field path ${JSON.stringify(path)}: must match /^[A-Za-z_][A-Za-z0-9_]*$/`);
  }
}

/** Input root: update writes `inputs[changes][key]`, create/scenario `inputs[key]`. */
function fieldName(mode: FormMode, path: string): string {
  return mode === "update" ? `inputs[changes][${path}]` : `inputs[${path}]`;
}

/**
 * Shared field-identity helpers (C4): control factories and label/validator
 * fragments derive identical names/ids from the same inputs. Returned values
 * are raw; callers escape for their context.
 */
export function fieldInputName(mode: FormMode, path: string): string {
  assertFieldPath(path);
  return fieldName(mode, path);
}
export function fieldInputId(idPrefix: string, path: string): string {
  assertFieldPath(path);
  return `${idPrefix}-${path}`;
}
export function fieldErrorOutletId(idPrefix: string, path: string): string {
  assertFieldPath(path);
  return `${idPrefix}-${path}-error`;
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

/**
 * Serialize one pre-bound action scalar to its hidden-input value.
 * Exported for internal reuse (navigation button bindings); not public API.
 */
export function serializeActionScalar(key: string, value: unknown): string {
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
  /** Raw outcome errors; explicit-control factories and validator() filter these themselves. */
  readonly errors: readonly FieldError[] | undefined;
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
  /**
   * True when the widget already emits its own named hidden (the T20b file
   * slot): renderField skips the readonly duplicate so the name is
   * emitted exactly once.
   */
  readonly suppressDuplicate?: boolean;
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

function fileFieldValue(field: FormFieldDef): string | null {
  const value = field.value;
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(`field "${field.path}": type ${field.type} needs an opaque file id string`);
  }
  return value;
}

/**
 * T20b file slot: an unnamed picker plus a hidden carrying the opaque
 * finalized id. The picker stays unnamed so raw picker text (a fake path,
 * never authority) cannot enter the submitted flat map; the UI client
 * uploads picked bytes through the S7 intent flow and fills the hidden
 * before projecting. A draft id re-renders as an attached line + the same
 * hidden, so resubmitting without re-picking keeps it; attach authority
 * is rechecked server-side per the T19b file rule.
 */
function fileWidget(
  field: FormFieldDef,
  attrs: WidgetAttrs,
  context: PresentationContext,
): WidgetResult {
  const attached = fileFieldValue(field) ?? "";
  const picker =
    `<input type="file" data-can-file="${escapeAttr(field.path)}" id="${attrs.idAttr}" ` +
    `class="file-input"${attrs.common}>`;
  const slot = `<input type="hidden" name="${attrs.nameAttr}" value="${escapeAttr(attached)}">`;
  const line =
    attached === ""
      ? ""
      : `<p><span>${escapeHtml(resolveCaption(CHROME.attachedLead, context))}</span> ` +
        `<code>${escapeHtml(attached)}</code></p>`;
  return { html: picker + slot + line, submitValue: attached, suppressDuplicate: true };
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
    return fileWidget(field, attrs, context);
  }
  if (type === "delivery") {
    return deliveryWidget(field, attrs, context);
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

/**
 * Explicit-control dispatch (C4b): when field.control is set, the complete
 * unit (fieldset + label + widget + outlet) renders through the matching
 * controls.ts factory instead of renderWidget. Suitability throws from the
 * factories propagate (fail closed); unknown control strings — prevented by
 * TypeScript, reachable from JS callers — throw naming the field.
 *
 * Appearance boundary: FormFieldDef carries NO appearance fields, so form
 * dispatch passes identity + data props only (context, field, idPrefix,
 * mode, errors, timeZone) and catalog defaults apply. Explicit appearance
 * on form fields arrives via generated code calling the controls.ts
 * factories directly with tone/size/variant/orientation.
 */
async function renderExplicitControl(field: FormFieldDef, ctx: FieldRenderContext): Promise<string> {
  const shared = {
    context: ctx.context,
    field,
    idPrefix: ctx.idPrefix,
    mode: ctx.mode,
    ...(ctx.errors === undefined ? {} : { errors: ctx.errors }),
    timeZone: ctx.timeZone,
  };
  switch (field.control) {
    case "input":
      return input(shared);
    case "textarea":
      return textarea(shared);
    case "checkbox":
      return checkbox(shared);
    case "toggle":
      return toggle(shared);
    case "radio":
      return radio(shared);
    case "select":
      return select(shared);
    case "range":
      return range(shared);
    case "rating":
      return rating(shared);
    case "file_input":
      return fileInput(shared);
    case "otp":
      return otp(shared);
    case "filter":
      return filter(shared);
    case "calendar":
      return calendar({ ...shared, kind: "field" });
    default: {
      const seen: unknown = field.control;
      throw new Error(`field "${field.path}": unknown control ${JSON.stringify(seen)}`);
    }
  }
}

/** One fieldset: label, widget, per-field errors; readonly adds a hidden duplicate. */
async function renderField(field: FormFieldDef, ctx: FieldRenderContext): Promise<string> {
  assertFieldPath(field.path);
  if (field.control !== undefined) {
    return renderExplicitControl(field, ctx);
  }
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
  // Single implementation of "moves, never duplicates": the default label
  // renders through the controls.ts label() fragment. caption passes through
  // only when set, so its caption ?? labelCaption ?? label resolution stays
  // byte-identical to the inline version it replaces.
  const labelHtml = await label({
    context: ctx.context,
    field,
    idPrefix: ctx.idPrefix,
    ...(field.labelCaption === undefined ? {} : { caption: field.labelCaption }),
  });
  // validator() always renders its outlet div (a stable swap target), while
  // the default unit omits the outlet when the field has no errors; the
  // fragment is reused only for the error case so default output stays
  // byte-identical. Filtering the raw errors through the fragment matches
  // the pre-split errorsByName list for this field exactly.
  const errorHtml =
    fieldErrors.length === 0
      ? ""
      : await validator({
          context: ctx.context,
          field,
          idPrefix: ctx.idPrefix,
          mode: ctx.mode,
          ...(ctx.errors === undefined ? {} : { errors: ctx.errors }),
        });
  const duplicate =
    field.readonly === true && widget.suppressDuplicate !== true
      ? hidden(name, widget.submitValue)
      : "";
  return `<fieldset>${labelHtml}${widget.html}${errorHtml}${duplicate}</fieldset>`;
}

/**
 * Explicit-placement duplicate rule (C4b): two fields sharing a path would
 * render two inputs for one binding, so the second occurrence throws naming
 * the path. Design: UI-COMPONENTS.md "A selector may have only one writable
 * control".
 */
function assertUniqueFieldPaths(fields: readonly FormFieldDef[]): void {
  const seen = new Set<string>();
  for (const field of fields) {
    assertFieldPath(field.path);
    if (seen.has(field.path)) {
      throw new Error(
        `duplicate field path ${JSON.stringify(field.path)}: explicit placement must not duplicate inputs`,
      );
    }
    seen.add(field.path);
  }
}

/**
 * Multipart join (C4b): a file_input explicit control switches the form to
 * multipart/form-data; the urlencoded default applies otherwise. Without
 * file fields no enctype attribute is emitted.
 *
 * T20b correction: the operation dispatcher accepts JSON and urlencoded
 * bodies only (multipart op POSTs are rejected `validation`, pinned E-side)
 * — file bytes never ride the op POST. Production submits go through the UI
 * client, which uploads picked bytes via the S7 intent flow and submits the
 * finalized opaque id as JSON. The enctype emission is retained for native
 * file-capable hosts (S4 byte-pins), not as a dispatcher transport claim.
 */
function needsMultipart(fields: readonly FormFieldDef[] | undefined): boolean {
  if (fields === undefined) {
    return false;
  }
  return fields.some((field) => field.control === "file_input");
}

function formOpenTag(action: string, multipart: boolean, derived?: DerivedOperationInputs, renderedInputs?: readonly string[]): string {
  const encoding = multipart ? ` enctype="multipart/form-data"` : "";
  const projection = derived === undefined ? ""
    : ` data-can-generated-form="${escapeAttr(JSON.stringify({ derived, mode: derived.kind, renderedInputs }))}"`;
  return `<form action="${escapeAttr(safeHref(action))}" method="post"${encoding}${projection}>`;
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

/** True for exact-keys `{minor, currency}` money objects (the L2 wire shape). */
function isMoneyObject(value: unknown): value is { readonly minor: string; readonly currency: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "currency" || keys[1] !== "minor") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record["minor"] === "string" && typeof record["currency"] === "string";
}

/** True for `{id}`/`{id, version}` ref objects (the ReadRef/MutationRef shapes). */
function isRefObject(value: unknown): value is { readonly id: string; readonly version?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string") {
    return false;
  }
  const version = record["version"];
  if (version !== undefined && typeof version !== "string") {
    return false;
  }
  return Object.keys(record).every((key) => key === "id" || key === "version");
}

/** Current value cell: typed formatScalar, falling back to raw escaped text. */
function formatCurrentValue(
  type: string | undefined,
  value: unknown,
  context: PresentationContext,
  timeZone: string,
): string {
  if (isMoneyObject(value)) {
    try {
      const scale = context.currencyScales?.[value.currency];
      if (scale === undefined) {
        throw new Error("money current needs a currency scale");
      }
      return escapeHtml(
        formatMoneyExact({
          minor: BigInt(value.minor),
          currency: value.currency,
          scale,
          locale: pageLocale(context),
        }),
      );
    } catch {
      return escapeHtml(rawText(value));
    }
  }
  if (isRefObject(value)) {
    return escapeHtml(
      value.version === undefined ? value.id : `${value.id} (v${value.version})`,
    );
  }
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
 * Authored children replace only the automatic field body, in authored order.
 * In that mode fields must describe the controls actually rendered: errors
 * for omitted controls then remain visible in the unmatched top banner.
 * Transport fields, outcome banners and the submit/cancel row remain canonical.
 */
export async function form(props: FormProps): Promise<string> {
  if (props.derived !== undefined) {
    assertGeneratedMode(props.derived, props.mode);
    if (props.operation !== props.derived.operation) throw new Error("form: operation disagrees with checked inputs");
  }
  if (props.mode === "update" && props.record === undefined) {
    throw new Error("form: update mode requires a bound record");
  }
  assertUniqueFieldPaths(props.fields);
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
    errors: props.errors,
  };
  const rendered: string[] = [];
  if (props.children === undefined) {
    for (const field of props.fields) {
      rendered.push(await renderField(field, fieldCtx));
    }
  } else {
    const children = typeof props.children === "function" ? await props.children() : props.children;
    rendered.push(...(await Promise.all(children)));
  }
  const fieldsHtml = rendered.join("");
  const submitLabel = escapeHtml(resolveCaption(props.submit, props.context));
  const renderedForm = (
    formOpenTag(props.action, needsMultipart(props.fields), props.derived, props.fields.map(field => field.path)) +
    hidden("operation", props.operation) +
    hidden("operation_id", props.operationId) +
    hidden(CSRF_FIELD, props.context.csrfToken) +
    hidden("timezone", props.timeZone) +
    recordHiddens(props.record) +
    outcomeBanner(props.outcome, props.fields, props.context, props.timeZone) +
    unmatchedAlert(unmatched, props.context) +
    (props.derived === undefined ? "" : '<div data-can-form-feedback role="alert" aria-live="polite" hidden></div>') +
    fieldsHtml +
    `<div class="flex gap-4"><button type="submit" class="btn btn-primary">${submitLabel}</button>${cancelLink(props.cancelHref, props.context)}</div>` +
    `</form>`
  );
  return props.display === "drawer"
    ? drawer({
        context: props.context,
        id: `${props.idPrefix}-drawer`,
        caption: props.submit,
        content: [renderedForm],
      })
    : renderedForm;
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
    assertUniqueFieldPaths(props.fields);
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
      errors: props.errors,
    };
    const rendered: string[] = [];
    for (const field of props.fields) {
      rendered.push(await renderField(field, fieldCtx));
    }
    fieldsHtml = rendered.join("");
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
  const labelText = escapeHtml(resolveCaption(props.label, props.context));
  return (
    formOpenTag(props.action, needsMultipart(props.fields)) +
    hidden("operation", props.operation) +
    hidden("operation_id", props.operationId) +
    hidden(CSRF_FIELD, props.context.csrfToken) +
    extras +
    errorsHtml +
    fieldsHtml +
    confirm +
    `<div class="flex gap-4"><button type="submit" class="btn ${tone}">${labelText}</button></div>` +
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

/**
 * T20a generated operation forms over T19a derived inputs (pilot scope).
 *
 * generatedFields() maps one DerivedOperationInputs to its FormFieldDef[]
 * under the presentation contract's pinned rule (one field per derived
 * input in emission order; the update `record` binds as hidden id/version
 * instead); generatedForm() renders those fields through the canonical
 * form() factory, so error re-renders through the same binding produce
 * the same structure for fragment morphing. projectGeneratedInputs() is
 * the client-side submission projection: flat submitted form values back
 * to the closed envelope inputs the real dispatcher admits. The L6
 * transport carries `inputs` as JSON text (or a JSON body) — bracket
 * field names are never expanded server-side — so this projection is the
 * documented form-to-envelope step; production clients run it before
 * submit (L7 wiring remainder), and the dispatcher still judges
 * presence, shape and business validity on the envelope.
 */

/**
 * Mode/derivation agreement: the caller states the form mode and the
 * factory verifies it against the derived kind. `read`/`delete`
 * derivations have no generated form — reads are not forms and deletes
 * render the delete card — so any mismatch throws naming both.
 */
function assertGeneratedMode(derived: DerivedOperationInputs, mode: FormMode): void {
  if (derived.kind !== mode) {
    throw new Error(
      `generated form for ${JSON.stringify(derived.operation)}: mode ${JSON.stringify(mode)} ` +
        `does not agree with derived kind ${JSON.stringify(derived.kind)} ` +
        `(read/delete derivations have no generated form).`,
    );
  }
}

/** True for the update `record` input, which binds as hidden id/version. */
function isBoundRecord(input: DerivedWritableInput, mode: FormMode): boolean {
  return mode === "update" && input.kind === "ref" && input.name === "record";
}

/**
 * One derived input's literal prefill, verbatim. Money object literals
 * (`{minor, currency}` wire shape) prefill their minor units — the form
 * widget is minor-only by S4 design; array literals travel JSON-encoded.
 * `parent` defaults prefill nothing: omission defers to the engine.
 */
function literalPrefill(input: DerivedWritableInput): unknown {
  const fallback = input.default;
  if (fallback === undefined || fallback.kind !== "literal") {
    return undefined;
  }
  let prefill: unknown = fallback.value;
  if (
    input.kind === "money" &&
    typeof prefill === "object" &&
    prefill !== null &&
    !Array.isArray(prefill) &&
    "minor" in prefill
  ) {
    prefill = (prefill as Record<string, unknown>)["minor"];
  }
  if (input.array !== undefined && typeof prefill !== "string") {
    const json: string | undefined = JSON.stringify(prefill);
    if (json !== undefined) {
      prefill = json;
    }
  }
  return prefill;
}

function generatedLabel(
  path: string,
  labels: Record<string, MessageValue> | undefined,
): MessageValue {
  return labels?.[path] ?? path;
}

/**
 * One money input's literal currency prefill: the `currency` member of a
 * `{minor, currency}` wire literal, verbatim. Anything else (no default,
 * `parent`, a non-object literal) prefills nothing — the minor widget's
 * own prefill judges malformed money literals loudly at render.
 */
function currencyPrefill(input: DerivedWritableInput): unknown {
  const fallback = input.default;
  if (fallback === undefined || fallback.kind !== "literal") {
    return undefined;
  }
  const prefill = fallback.value;
  if (typeof prefill === "object" && prefill !== null && !Array.isArray(prefill)) {
    return (prefill as Record<string, unknown>)["currency"];
  }
  return undefined;
}

/** T20b explicit-null companion convention: `<name>__null` carries the clear. */
export const GENERATED_NULL_SUFFIX = "__null";

/** T20b money companion convention: `<name>__currency` carries the currency. */
export const GENERATED_MONEY_CURRENCY_SUFFIX = "__currency";

/** T20b datetime companion convention: `<name>__fold` carries earlier/later. */
export const GENERATED_DATETIME_FOLD_SUFFIX = "__fold";

/**
 * Fold choices for ambiguous wall times. The empty lead keeps the select
 * choice-free until the user picks — an ambiguous value requires explicit
 * selection (DESIGN §9), never a defaulted guess.
 */
const FOLD_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: MessageValue }> = [
  { value: "", label: "—" },
  { value: "earlier", label: "earlier" },
  { value: "later", label: "later" },
];

/**
 * Validate one T19b engine-resolved delivery binding and return it. Every
 * member of the wire `DerivedDeliveryBinding` shape is fenced: capability,
 * operation, integer version, recipe, result name and verbatim {name, type}
 * leaves. Anything else is not a real derivation and throws naming the
 * input — the notice below renders binding members verbatim, never guessed.
 */
function checkedDeliveryBinding(
  derived: DerivedOperationInputs,
  input: DerivedWritableInput,
): DerivedDeliveryBinding {
  const fail = (detail: string): Error =>
    new Error(
      `generated form for ${JSON.stringify(derived.operation)}: ` +
        `delivery input ${JSON.stringify(input.name)} ${detail}.`,
    );
  const binding = input.delivery;
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) {
    throw fail("needs its engine-resolved delivery binding");
  }
  const record = binding as unknown as Record<string, unknown>;
  if (
    typeof record["capability"] !== "string" ||
    record["capability"] === "" ||
    typeof record["operation"] !== "string" ||
    record["operation"] === ""
  ) {
    throw fail("needs a binding with string capability and operation");
  }
  if (typeof record["version"] !== "number" || !Number.isInteger(record["version"])) {
    throw fail("needs a binding with an integer version");
  }
  if (typeof record["recipe"] !== "string" || record["recipe"] === "") {
    throw fail("needs a binding with a string recipe");
  }
  const result = record["result"];
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw fail("needs a binding with a result object");
  }
  const resultRecord = result as Record<string, unknown>;
  if (typeof resultRecord["name"] !== "string" || resultRecord["name"] === "") {
    throw fail("needs a binding with a string result name");
  }
  const leaves = resultRecord["leaves"];
  if (!Array.isArray(leaves)) {
    throw fail("needs a binding with a leaves array");
  }
  for (const leaf of leaves) {
    if (leaf === null || typeof leaf !== "object" || Array.isArray(leaf)) {
      throw fail("needs leaves shaped {name, type}");
    }
    const leafRecord = leaf as Record<string, unknown>;
    if (typeof leafRecord["name"] !== "string" || typeof leafRecord["type"] !== "string") {
      throw fail("needs leaves shaped {name, type}");
    }
  }
  return binding;
}

/**
 * Map one T19 derived operation to its form fields: one field per derived
 * input in emission order (the update `record` binds as hidden id/version
 * and is excluded; `delivery` inputs render a display-only notice field
 * with no submittable member), widgets per the pinned kind table, enum
 * options from the
 * derived values verbatim, literal defaults prefilled verbatim, a
 * `__version` text companion after each versioned non-record ref, a
 * `__currency` text companion after each money input, a `__fold` select
 * after each datetime input, and a `__null` checkbox after each nullable
 * non-delivery input. Unknown kinds, ref inputs without a boolean
 * versioned flag, enums without values, delivery inputs without their
 * binding, and prefill keys matching no generated path all throw precisely
 * — never a guessed widget or a dropped value.
 */
export function generatedFields(
  derived: DerivedOperationInputs,
  mode: FormMode,
  overrides: GeneratedFormOverrides = {},
): FormFieldDef[] {
  assertGeneratedMode(derived, mode);
  const fields: FormFieldDef[] = [];
  for (const input of derived.inputs) {
    if (isBoundRecord(input, mode)) {
      continue;
    }
    if (input.kind === "delivery") {
      // Engine-resolved receipt declarations render as a display-only
      // notice field (no companions, no submittable member): the closed
      // envelope carries no delivery member (T19b wire rule). The notice
      // stays a field so error re-renders keep it through the binding.
      const binding = checkedDeliveryBinding(derived, input);
      fields.push({
        path: input.name,
        label: generatedLabel(input.name, overrides.labels),
        type: "delivery",
        required: false,
        value: binding,
      });
      continue;
    }
    // String-indexed on purpose: kinds outside the pinned pilot table
    // (or JS-only inventions) read undefined and throw below.
    const table = GENERATED_FORM_TYPE_FOR_KIND as Record<string, string | undefined>;
    const type: unknown = table[input.kind];
    if (typeof type !== "string") {
      throw new Error(
        `generated form for ${JSON.stringify(derived.operation)}: ` +
          `unknown input kind ${JSON.stringify(input.kind)} on ${JSON.stringify(input.name)}.`,
      );
    }
    if (input.kind === "ref" && input.versioned !== true && input.versioned !== false) {
      throw new Error(
        `generated form for ${JSON.stringify(derived.operation)}: ` +
          `ref input ${JSON.stringify(input.name)} needs a boolean versioned flag.`,
      );
    }
    const field: FormFieldDef = {
      path: input.name,
      label: generatedLabel(input.name, overrides.labels),
      type,
      required: input.required,
      ...(input.kind === "enum"
        ? {
            options: ((): ReadonlyArray<{ readonly value: string; readonly label: MessageValue }> => {
              if (input.enumValues === undefined) {
                throw new Error(
                  `generated form for ${JSON.stringify(derived.operation)}: ` +
                    `enum input ${JSON.stringify(input.name)} needs enumValues.`,
                );
              }
              return input.enumValues.map((value) => ({ value, label: value }));
            })(),
          }
        : {}),
      ...(literalPrefill(input) === undefined ? {} : { value: literalPrefill(input) }),
    };
    fields.push(field);
    if (input.kind === "ref" && input.versioned === true) {
      const companion = `${input.name}${GENERATED_REF_VERSION_SUFFIX}`;
      fields.push({
        path: companion,
        label: generatedLabel(companion, overrides.labels),
        type: "text",
        required: input.required,
      });
    }
    if (input.kind === "money") {
      const companion = `${input.name}${GENERATED_MONEY_CURRENCY_SUFFIX}`;
      const prefill = currencyPrefill(input);
      fields.push({
        path: companion,
        label: generatedLabel(companion, overrides.labels),
        type: "text",
        required: false,
        ...(prefill === undefined ? {} : { value: prefill }),
      });
    }
    if (input.kind === "datetime") {
      // The fold select stays statically optional: the projection
      // requires an explicit earlier/later choice only when the
      // submitted wall time is actually ambiguous in the form zone.
      const companion = `${input.name}${GENERATED_DATETIME_FOLD_SUFFIX}`;
      fields.push({
        path: companion,
        label: generatedLabel(companion, overrides.labels),
        type: "enum",
        required: false,
        options: FOLD_OPTIONS,
      });
    }
    if (input.nullable === true) {
      const companion = `${input.name}${GENERATED_NULL_SUFFIX}`;
      fields.push({
        path: companion,
        label: generatedLabel(companion, overrides.labels),
        type: "bool",
        required: false,
      });
    }
  }
  const values = overrides.values ?? {};
  const paths = new Set(fields.map((field) => field.path));
  for (const key of Object.keys(values)) {
    if (!paths.has(key)) {
      throw new Error(
        `generated form for ${JSON.stringify(derived.operation)}: ` +
          `unknown prefill path ${JSON.stringify(key)}.`,
      );
    }
  }
  if (Object.keys(values).length === 0) {
    return fields;
  }
  return fields.map((field) =>
    Object.prototype.hasOwnProperty.call(values, field.path)
      ? { ...field, value: values[field.path] }
      : field,
  );
}

/**
 * Validate one carried delivery binding value: the same wire
 * `DerivedDeliveryBinding` shape `checkedDeliveryBinding` fences on the
 * derivation, reported against the rendered field so error re-renders can
 * drop a tampered value through the established resilient path.
 */
function checkedDeliveryValue(fieldPath: string, value: unknown): DerivedDeliveryBinding {
  const fail = (detail: string): Error => new Error(`field "${fieldPath}": ${detail}.`);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw fail("delivery notice needs its engine-resolved binding value");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record["capability"] !== "string" ||
    record["capability"] === "" ||
    typeof record["operation"] !== "string" ||
    record["operation"] === ""
  ) {
    throw fail("delivery notice needs string capability and operation");
  }
  if (typeof record["version"] !== "number" || !Number.isInteger(record["version"])) {
    throw fail("delivery notice needs an integer version");
  }
  const result = record["result"];
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw fail("delivery notice needs a result object");
  }
  const resultRecord = result as Record<string, unknown>;
  if (typeof resultRecord["name"] !== "string" || resultRecord["name"] === "") {
    throw fail("delivery notice needs a string result name");
  }
  const leaves = resultRecord["leaves"];
  if (!Array.isArray(leaves)) {
    throw fail("delivery notice needs a leaves array");
  }
  for (const leaf of leaves) {
    if (leaf === null || typeof leaf !== "object" || Array.isArray(leaf)) {
      throw fail("delivery notice needs leaves shaped {name, type}");
    }
    const leafRecord = leaf as Record<string, unknown>;
    if (typeof leafRecord["name"] !== "string" || typeof leafRecord["type"] !== "string") {
      throw fail("delivery notice needs leaves shaped {name, type}");
    }
  }
  return value as DerivedDeliveryBinding;
}

/**
 * Display-only receipt declaration for one `delivery` field: the validated
 * binding (capability operation, fenced version, declared result nominal
 * with its verbatim leaves) rendered as information inside the field's
 * fieldset, with no named inputs anywhere — the caller submits nothing
 * for these members. Receipts resolve engine-side at dispatch; the
 * post-dispatch outcome banner (not this notice) reports their status.
 * The binding travels as the field value (set by generatedFields, never
 * overwritten by drafts — the envelope carries no delivery member).
 */
function deliveryWidget(
  field: FormFieldDef,
  attrs: WidgetAttrs,
  context: PresentationContext,
): WidgetResult {
  const binding = checkedDeliveryValue(field.path, field.value);
  const lead = escapeHtml(resolveCaption(CHROME.deliveryLead, context));
  const target = `${binding.capability}.${binding.operation}`;
  const rows = binding.result.leaves
    .map(
      (leaf) =>
        `<tr><td>${escapeHtml(leaf.name)}</td><td><code>${escapeHtml(leaf.type)}</code></td></tr>`,
    )
    .join("");
  return {
    html:
      `<section class="can-delivery" data-delivery="${escapeAttr(field.path)}" ` +
      `aria-label="${escapeAttr(`${resolveCaption(CHROME.deliveryLead, context)}: ${target}`)}">` +
      `<p>${lead}: <code>${escapeHtml(target)}</code> ` +
      `<span>v${escapeHtml(String(binding.version))}</span></p>` +
      `<p>${escapeHtml(binding.result.name)}</p>` +
      `<table class="table"><tbody>${rows}</tbody></table></section>`,
    submitValue: "",
  };
}

/**
 * Canonical generated operation form: generatedFields() rendered through
 * form(), carrying the same hidden operation/operation_id/CSRF/timezone
 * fields (plus the bound record) as every bound form. Update mode
 * requires the bound record; denials re-render through the same fields
 * via the operation's error binding.
 */
export async function generatedForm(props: GeneratedFormProps): Promise<string> {
  const fields = generatedFields(props.derived, props.mode, {
    ...(props.labels === undefined ? {} : { labels: props.labels }),
    ...(props.values === undefined ? {} : { values: props.values }),
  });
  return form({
    context: props.context,
    action: props.action,
    operation: props.derived.operation,
    operationId: props.operationId,
    mode: props.mode,
    derived: props.derived,
    ...(props.record === undefined ? {} : { record: props.record }),
    timeZone: props.timeZone,
    fields,
    ...(props.errors === undefined ? {} : { errors: props.errors }),
    ...(props.outcome === undefined ? {} : { outcome: props.outcome }),
    submit: props.submit,
    ...(props.cancelHref === undefined ? {} : { cancelHref: props.cancelHref }),
    idPrefix: props.idPrefix,
  });
}

/**
 * Stable swap-target wrap for a rendered form fragment:
 * `<div id="<idPrefix>-form">`. Byte-identical in shape to the error
 * re-render's fragment wrap, so HTMX morph swaps target one stable node
 * for both the initial and the re-rendered form.
 */
export function formFragmentWrap(idPrefix: string, formHtml: string): string {
  return `<div id="${escapeAttr(`${idPrefix}-form`)}">${formHtml}</div>`;
}

function projectionFailure(derived: DerivedOperationInputs, message: string): Error {
  return new Error(`generated submit for ${JSON.stringify(derived.operation)}: ${message}`);
}

/** Native datetime-local shape: minute precision, no seconds, no offset. */
const WALL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Zone offset in milliseconds at one instant (positive east of UTC). */
function zoneOffsetMs(timeZone: string, epochMs: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const get = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) {
      throw new Error(`wallToInstant: missing ${type} part`);
    }
    const value = Number(found.value);
    if (!Number.isInteger(value)) {
      throw new Error(`wallToInstant: non-numeric ${type} part`);
    }
    return value;
  };
  return (
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) -
    epochMs
  );
}

/** Render one instant as a minute-precision wall time in the zone. */
function formatWallMs(timeZone: string, epochMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const get = (type: string): string => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) {
      throw new Error(`wallToInstant: missing ${type} part`);
    }
    return found.value;
  };
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/**
 * Resolve a submitted wall datetime to its canonical RFC3339 UTC instant
 * (always with millis, the values-wire pinned form) in the form's IANA
 * zone. Nonexistent local times (spring-forward gaps) throw a correctable
 * failure; ambiguous times (fall-back overlaps) require an explicit
 * `earlier`/`later` fold and throw until one arrives — never a guessed
 * occurrence. Unambiguous values ignore the fold; malformed walls, zones
 * and folds all throw precisely.
 */
export function wallToInstant(
  wall: string,
  timeZone: string,
  fold: string | undefined,
): string {
  if (typeof wall !== "string" || !WALL_DATETIME_RE.test(wall)) {
    throw new Error(`invalid wall datetime ${JSON.stringify(wall)}: expected "YYYY-MM-DDTHH:mm"`);
  }
  if (!isValidDate(wall.slice(0, 10)) || Number(wall.slice(11, 13)) > 23 || Number(wall.slice(14, 16)) > 59) {
    throw new Error(`invalid wall datetime ${JSON.stringify(wall)}: no such civil date/time`);
  }
  if (typeof timeZone !== "string" || timeZone === "") {
    throw new Error(`invalid time zone ${JSON.stringify(timeZone)}: expected a nonempty IANA zone`);
  }
  if (fold !== undefined && fold !== "" && fold !== "earlier" && fold !== "later") {
    throw new Error(`invalid fold ${JSON.stringify(fold)}: expected "earlier" or "later"`);
  }
  const candidate = Date.UTC(
    Number(wall.slice(0, 4)),
    Number(wall.slice(5, 7)) - 1,
    Number(wall.slice(8, 10)),
    Number(wall.slice(11, 13)),
    Number(wall.slice(14, 16)),
  );
  try {
    // Distinct offsets around the wall moment: each yields at most one
    // instant spelling this wall back. The ±25h/±12h probes span every
    // standard/DST transition window (gaps and overlaps alike).
    const offsets = new Set<number>();
    for (const probe of [
      candidate - 25 * 3600000,
      candidate - 12 * 3600000,
      candidate,
      candidate + 12 * 3600000,
      candidate + 25 * 3600000,
    ]) {
      offsets.add(zoneOffsetMs(timeZone, probe));
    }
    const matches: number[] = [];
    for (const offset of offsets) {
      const instant = candidate - offset;
      if (formatWallMs(timeZone, instant) === wall && !matches.includes(instant)) {
        matches.push(instant);
      }
    }
    const single = matches.length === 1 ? matches[0] : undefined;
    if (single !== undefined) {
      return new Date(single).toISOString();
    }
    if (matches.length === 0) {
      throw new Error(
        `nonexistent local time ${JSON.stringify(wall)} in ${JSON.stringify(timeZone)}`,
      );
    }
    if (fold !== "earlier" && fold !== "later") {
      throw new Error(
        `ambiguous local time ${JSON.stringify(wall)} in ${JSON.stringify(timeZone)}: ` +
          `choose "earlier" or "later"`,
      );
    }
    const ordered = [...matches].sort((a, b) => a - b);
    const low = ordered[0];
    const high = ordered[ordered.length - 1];
    if (low === undefined || high === undefined) {
      throw new Error("wallToInstant: ambiguous time lost its candidates");
    }
    return new Date(fold === "earlier" ? low : high).toISOString();
  } catch (error) {
    // Only Intl rejects zones (RangeError); every other throw above is
    // already precise and passes through untouched.
    if (error instanceof RangeError) {
      throw new Error(`invalid time zone ${JSON.stringify(timeZone)}`);
    }
    throw error;
  }
}

/**
 * Project one array member: absent/empty optional arrays omit (omission
 * defers to the engine); anything present must parse as a JSON array,
 * else the projection throws precisely — the envelope never carries a
 * malformed array.
 */
function projectArrayValue(
  derived: DerivedOperationInputs,
  input: DerivedWritableInput,
  raw: string | undefined,
): { readonly omit: boolean; readonly value?: readonly unknown[] } {
  if (raw === undefined || raw === "") {
    if (!input.required) {
      return { omit: true };
    }
    throw projectionFailure(
      derived,
      `array input ${JSON.stringify(input.name)} needs JSON-array text.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw projectionFailure(
      derived,
      `array input ${JSON.stringify(input.name)} needs JSON-array text.`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw projectionFailure(
      derived,
      `array input ${JSON.stringify(input.name)} needs JSON-array text.`,
    );
  }
  return { omit: false, value: parsed };
}

/**
 * Resolve the projection timezone: the form's `timezone` member when
 * present, else UTC — unless a datetime input carries a value, which
 * needs the real zone to resolve and fails loudly without it.
 */
function resolveProjectionZone(
  derived: DerivedOperationInputs,
  mode: FormMode,
  form: Record<string, string>,
  root: (name: string) => string,
  renderedInputs?: ReadonlySet<string>,
): string {
  const zone = form["timezone"];
  if (zone !== undefined && (typeof zone !== "string" || zone === "")) {
    throw projectionFailure(derived, "the form timezone must be a nonempty string");
  }
  if (typeof zone === "string") {
    return zone;
  }
  for (const input of derived.inputs) {
    if (isBoundRecord(input, mode) || input.kind !== "datetime" ||
        (renderedInputs !== undefined && !renderedInputs.has(input.name))) {
      continue;
    }
    const raw = form[root(input.name)];
    if (raw !== undefined && raw !== "") {
      throw projectionFailure(
        derived,
        `datetime input ${JSON.stringify(input.name)} needs the form timezone to resolve to an instant`,
      );
    }
  }
  return "UTC";
}

/**
 * Client-side submission projection: flat submitted form values (one
 * entry per rendered field name, as a form parser yields them) back to
 * the closed envelope inputs for one derived operation. Reads exactly
 * the names the generated form renders — `inputs[name]` under
 * create/scenario, `inputs[changes][name]` under update, the record
 * hiddens, and the `__version`/`__currency`/`__fold`/`__null`
 * companions — and ignores every other member (transport fields,
 * submit buttons, tampered extras never enter the envelope). Absent
 * members omit so the dispatcher judges presence; empty optional
 * scalars omit so omission defers to the engine; bools coerce
 * (`"true"`/`"false"`, absent reads unchecked-false); refs compose
 * `{id}`/`{id, version}`; money composes `{minor, currency}`;
 * datetimes resolve wall-to-instant in the form zone; files travel as
 * their opaque id; an explicit `__null` on a nullable input projects
 * JSON null. `delivery` inputs never emit a member, even under
 * tampering. Present-but-unprojectable values (malformed array JSON,
 * non-bool text, gap/ambiguous datetimes, mistyped folds) throw
 * precisely — the projection never guesses a typed value. Business
 * validity always stays with the dispatcher/engine. Optional rendered-input
 * names limit projection to those exact field paths; explicitly supplied
 * update record hiddens still project. Omission keeps the legacy full-input
 * projection, including unchecked booleans.
 */
export function projectGeneratedInputs(
  derived: DerivedOperationInputs,
  mode: FormMode,
  form: Record<string, string>,
  renderedInputs?: readonly string[],
): ClosedInputs {
  assertGeneratedMode(derived, mode);
  const root = (name: string): string =>
    mode === "update" ? `inputs[changes][${name}]` : `inputs[${name}]`;
  const rendered = renderedInputs === undefined ? undefined : new Set(renderedInputs);
  const timeZone = resolveProjectionZone(derived, mode, form, root, rendered);
  const out: Record<string, unknown> = {};
  for (const input of derived.inputs) {
    if (isBoundRecord(input, mode)) {
      const id = form["inputs[record][id]"];
      const version = form["inputs[record][version]"];
      if (id === undefined && version === undefined) {
        continue;
      }
      out[input.name] = {
        ...(id === undefined ? {} : { id }),
        ...(version === undefined ? {} : { version }),
      };
      continue;
    }
    if (input.kind === "delivery" || (rendered !== undefined && !rendered.has(input.name))) {
      // Engine-resolved or unrendered: never submitted, even when the
      // flat map carries a tampered member for it.
      continue;
    }
    if (
      input.nullable === true &&
      form[root(`${input.name}${GENERATED_NULL_SUFFIX}`)] === "true"
    ) {
      // Explicit null wins over the value widget. A `__null` mark on a
      // non-nullable input is ignored above (never enters the envelope).
      out[input.name] = null;
      continue;
    }
    if (input.kind === "ref") {
      const id = form[root(input.name)];
      if ((id === undefined || id === "") && !input.required) {
        continue;
      }
      if (input.versioned === true) {
        const version = form[root(`${input.name}${GENERATED_REF_VERSION_SUFFIX}`)];
        out[input.name] = {
          id: id ?? "",
          ...(version === undefined ? {} : { version }),
        };
      } else {
        out[input.name] = { id: id ?? "" };
      }
      continue;
    }
    const raw = form[root(input.name)];
    if (input.array !== undefined) {
      const projected = projectArrayValue(derived, input, raw);
      if (!projected.omit) {
        out[input.name] = projected.value;
      }
      continue;
    }
    if (input.kind === "boolean") {
      if (raw === undefined) {
        out[input.name] = false;
      } else if (raw === "true") {
        out[input.name] = true;
      } else if (raw === "false") {
        out[input.name] = false;
      } else {
        throw projectionFailure(
          derived,
          `bool input ${JSON.stringify(input.name)} needs "true" or "false".`,
        );
      }
      continue;
    }
    if (input.kind === "datetime") {
      if (raw === undefined) {
        continue;
      }
      if (raw === "") {
        // Cleared travels verbatim for the engine to judge, like every
        // other cleared scalar.
        out[input.name] = "";
        continue;
      }
      try {
        out[input.name] = wallToInstant(
          raw,
          timeZone,
          form[root(`${input.name}${GENERATED_DATETIME_FOLD_SUFFIX}`)],
        );
      } catch (error) {
        throw projectionFailure(
          derived,
          `datetime input ${JSON.stringify(input.name)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }
    if (input.kind === "file") {
      // The opaque finalized id, filled by the client after the S7
      // intent flow. Cleared travels verbatim; the bound checker
      // rejects it correctably.
      if (raw === undefined) {
        continue;
      }
      out[input.name] = raw;
      continue;
    }
    if (input.kind === "money") {
      const currency = form[root(`${input.name}${GENERATED_MONEY_CURRENCY_SUFFIX}`)];
      if (raw === undefined && currency === undefined) {
        continue;
      }
      // Verbatim minor + caller-supplied currency: the exact-keys
      // `{minor, currency}` wire shape. ISO membership is judged at
      // the L2 values boundary, never invented here.
      out[input.name] = { minor: raw ?? "", currency: currency ?? "" };
      continue;
    }
    if (raw === undefined || raw === "") {
      if (!input.required) {
        continue;
      }
      if (raw === undefined) {
        continue;
      }
    }
    out[input.name] = raw;
  }
  return out;
}

/** Plain-object check for draft subtrees (envelope members, `changes`). */
function isDraftRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flatten one failed envelope's business inputs back onto the generated
 * field paths (the ref-draft carry): refs split into id + `__version`
 * companion, money splits into minor + `__currency` companion, arrays
 * re-encode as JSON text, and explicit nulls mark their `__null`
 * companion. Scalars (string/integer/decimal/enum/datetime/file/boolean)
 * pass through verbatim — the widgets judge wrong-typed drafts and the
 * error re-render drops them through the established resilient path.
 * Update mode reads `changes.*` (the bound `record` stays envelope-side,
 * owned by the re-render's record extraction); `delivery` inputs and
 * unknown members flatten to nothing. Unflattenable structures omit
 * rather than guess. The interfaces error re-render calls this helper
 * for generated bindings so both sides agree on every draft shape.
 */
export function generatedDraftValues(
  derived: DerivedOperationInputs,
  mode: FormMode,
  inputs: ClosedInputs,
): Record<string, unknown> {
  assertGeneratedMode(derived, mode);
  const changes = inputs["changes"];
  const source: ClosedInputs =
    mode === "update" && isDraftRecord(changes) ? changes : inputs;
  const out: Record<string, unknown> = {};
  for (const input of derived.inputs) {
    if (isBoundRecord(input, mode) || input.kind === "delivery") {
      continue;
    }
    if (!Object.hasOwn(source, input.name)) {
      continue;
    }
    const member = source[input.name];
    if (member === undefined) {
      continue;
    }
    if (member === null) {
      if (input.nullable === true) {
        out[`${input.name}${GENERATED_NULL_SUFFIX}`] = true;
      }
      continue;
    }
    if (input.kind === "ref") {
      if (!isDraftRecord(member) || typeof member["id"] !== "string") {
        continue;
      }
      out[input.name] = member["id"];
      if (input.versioned === true && typeof member["version"] === "string") {
        out[`${input.name}${GENERATED_REF_VERSION_SUFFIX}`] = member["version"];
      }
      continue;
    }
    if (input.kind === "money") {
      if (!isDraftRecord(member)) {
        continue;
      }
      if (typeof member["minor"] === "string") {
        out[input.name] = member["minor"];
      }
      if (typeof member["currency"] === "string") {
        out[`${input.name}${GENERATED_MONEY_CURRENCY_SUFFIX}`] = member["currency"];
      }
      continue;
    }
    if (input.array !== undefined && Array.isArray(member)) {
      let json: string | undefined;
      try {
        json = JSON.stringify(member) ?? undefined;
      } catch {
        json = undefined;
      }
      if (json !== undefined) {
        out[input.name] = json;
      }
      continue;
    }
    out[input.name] = member;
  }
  return out;
}
