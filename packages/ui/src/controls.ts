/**
 * C4a field-control factories: input, textarea, checkbox, toggle, radio,
 * select, range, rating, fileInput, otp, label, validator, filter, calendar.
 *
 * Every complete-unit factory renders `<fieldset>` + label + widget +
 * per-field error outlet with names/ids identical to forms.ts renderField
 * (fieldInputName/fieldInputId/fieldErrorOutletId), errors filtered to its
 * own field via pointerToFieldName, appearance through appearanceClasses()
 * (undeclared runtime extras throw, never drop), and readonly fields as
 * disabled widgets plus a hidden duplicate. Drafts render verbatim, never
 * reformatted and never lossy.
 *
 * Temporal display honors props.timeZone (IANA, UTC default) for datetime
 * inputs, agenda day grouping and agenda cell text.
 */

import type {
  CalendarProps,
  CheckboxProps,
  DeliveryStatus,
  FieldControlProps,
  FileInputProps,
  FileLinkView,
  FileProps,
  FilterProps,
  FormFieldDef,
  InputProps,
  LabelProps,
  MessageValue,
  OtpProps,
  PresentationContext,
  RadioProps,
  RangeProps,
  RatingProps,
  RowView,
  SelectProps,
  TextareaProps,
  ToggleProps,
  ValidatorProps,
} from "@canlang/contracts";
import type { FieldError } from "@canlang/contracts";
import { appearanceClasses } from "./appearance.js";
import { pickAppearance } from "./internal/appearance-props.js";
import { renderState } from "./components.js";
import { escapeAttr, escapeHtml, safeHref } from "./escape.js";
import {
  assertFieldPath,
  fieldErrorOutletId,
  fieldInputId,
  fieldInputName,
  formatDatetimeLocal,
  pointerToFieldName,
} from "./forms.js";
import {
  canonicalDefaultTag,
  canonicalPreferredTags,
  formatScalar,
  message,
  resolveCaption,
} from "./messages.js";

const RANGE_INVALID = message("Value is outside the allowed range.", {
  nl: "Waarde valt buiten het toegestane bereik.",
});

const FILE_UNAVAILABLE = message("File unavailable", {
  nl: "Bestand niet beschikbaar",
});

/** String-valued scalar input types (mirrors forms.ts). */
const TEXT_TYPES = new Set(["text", "email", "url", "timezone", "locale", "currency"]);
const NUMERIC_TYPES = new Set(["int", "decimal", "money"]);
const TEMPORAL_TYPES = new Set(["date", "datetime"]);

const INT_RE = /^[+-]?\d+$/;
const DECIMAL_RE = /^[+-]?(?:\d+)(?:\.\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Fixed star count: the upstream rating convention (five mask inputs). */
const RATING_STARS = 5;
/** Upstream otp.css styles at most eight segment spans. */
const OTP_MAX_SEGMENTS = 8;
/** Row-query page bound, mirroring collections.ts. */
const MAX_LIMIT = 100;

function joinClasses(base: string, modifiers: string): string {
  return modifiers === "" ? base : `${base} ${modifiers}`;
}

function pageLocale(context: PresentationContext): string {
  const preferred = canonicalPreferredTags(context.preferredLocales);
  return preferred[0] ?? canonicalDefaultTag(context.appDefaultLocale);
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

/** This field's errors: outcome errors whose pointer maps to its input name. */
function ownErrors(props: FieldControlProps | ValidatorProps): FieldError[] {
  const name = fieldInputName(props.mode, props.field.path);
  const found: FieldError[] = [];
  for (const error of props.errors ?? []) {
    let mapped: string;
    try {
      mapped = pointerToFieldName(error.path);
    } catch {
      continue;
    }
    if (mapped === name) {
      found.push(error);
    }
  }
  return found;
}

function labelText(field: FormFieldDef, context: PresentationContext): string {
  const caption: MessageValue = field.labelCaption ?? field.label;
  return resolveCaption(caption, context);
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}">`;
}

// ---------------------------------------------------------------------------
// Draft value extractors (parity with forms.ts; errors name the field)
// ---------------------------------------------------------------------------

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

function numericFieldValue(field: FormFieldDef): string {
  if (field.type === "int") {
    return intFieldValue(field);
  }
  if (field.type === "decimal") {
    return decimalFieldValue(field);
  }
  return moneyFieldValue(field);
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
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`field "${field.path}": cannot format datetime in ${JSON.stringify(timeZone)}: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Complete-unit assembly (mirrors forms.ts renderField)
// ---------------------------------------------------------------------------

interface UnitContext {
  readonly name: string;
  readonly id: string;
  readonly errors: readonly FieldError[];
  /** Shared widget attributes: required/invalid/describedby/disabled. */
  readonly common: string;
}

function unitContext(props: FieldControlProps): UnitContext {
  assertFieldPath(props.field.path);
  const name = fieldInputName(props.mode, props.field.path);
  const id = fieldInputId(props.idPrefix, props.field.path);
  const errors = ownErrors(props);
  const describedBy =
    errors.length === 0 ? "" : ` aria-describedby="${escapeAttr(fieldErrorOutletId(props.idPrefix, props.field.path))}"`;
  const invalid = errors.length === 0 ? "" : ` aria-invalid="true"`;
  const requiredAttr = props.field.required ? ` aria-required="true"` : "";
  const disabled = props.field.readonly === true ? " disabled" : "";
  return { name, id, errors, common: `${requiredAttr}${invalid}${describedBy}${disabled}` };
}

function unitLabel(props: FieldControlProps, unit: UnitContext): string {
  const text = escapeHtml(labelText(props.field, props.context));
  const mark = props.field.required ? ` <span aria-hidden="true">*</span>` : "";
  return `<label for="${escapeAttr(unit.id)}" class="label">${text}${mark}</label>`;
}

function unitErrors(props: FieldControlProps, unit: UnitContext): string {
  if (unit.errors.length === 0) {
    return "";
  }
  const outlet = escapeAttr(fieldErrorOutletId(props.idPrefix, props.field.path));
  const items = unit.errors
    .map((error) => `<p class="text-error">${escapeHtml(error.message)}</p>`)
    .join("");
  return `<div id="${outlet}">${items}</div>`;
}

function unitDuplicate(props: FieldControlProps, unit: UnitContext, submitValue: string): string {
  return props.field.readonly === true ? hidden(unit.name, submitValue) : "";
}

function unit(
  props: FieldControlProps,
  unitCtx: UnitContext,
  widgetHtml: string,
  submitValue: string,
): string {
  return (
    `<fieldset>${unitLabel(props, unitCtx)}` +
    `${widgetHtml}${unitErrors(props, unitCtx)}${unitDuplicate(props, unitCtx, submitValue)}</fieldset>`
  );
}

function requireOptions(field: FormFieldDef, factory: string): NonNullable<FormFieldDef["options"]> {
  if (field.options === undefined || field.options.length === 0) {
    throw new Error(
      `field "${field.path}": ${factory} needs a finite non-empty option list`,
    );
  }
  return field.options;
}

function assertFieldType(field: FormFieldDef): void {
  if (typeof field.type !== "string") {
    throw new TypeError(`field "${field.path}": type must be a string`);
  }
}

// ---------------------------------------------------------------------------
// Textlike / scalar units
// ---------------------------------------------------------------------------

/**
 * Textlike and scalar single-line input: text/email/url/timezone/locale/
 * currency, int/decimal/money, and date/datetime (datetime-local formatted
 * in props.timeZone, UTC default). Other types throw, naming the field.
 */
export async function input(props: InputProps): Promise<string> {
  const modifiers = appearanceClasses("input", "input", pickAppearance(props));
  const field = props.field;
  assertFieldType(field);
  const unitCtx = unitContext(props);
  const nameAttr = escapeAttr(unitCtx.name);
  const idAttr = escapeAttr(unitCtx.id);
  const cls = escapeAttr(joinClasses("input", modifiers));
  if (TEXT_TYPES.has(field.type)) {
    const value = stringFieldValue(field) ?? "";
    const inputType = field.type === "email" ? "email" : field.type === "url" ? "url" : "text";
    return unit(
      props,
      unitCtx,
      `<input type="${inputType}" name="${nameAttr}" id="${idAttr}" value="${escapeAttr(value)}" class="${cls}"${unitCtx.common}>`,
      value,
    );
  }
  if (NUMERIC_TYPES.has(field.type)) {
    const value = numericFieldValue(field);
    return unit(
      props,
      unitCtx,
      `<input type="text" inputmode="decimal" name="${nameAttr}" id="${idAttr}" value="${escapeAttr(value)}" class="${cls}"${unitCtx.common}>`,
      value,
    );
  }
  if (field.type === "date") {
    const value = dateFieldValue(field);
    return unit(
      props,
      unitCtx,
      `<input type="date" name="${nameAttr}" id="${idAttr}" value="${escapeAttr(value)}" class="${cls}"${unitCtx.common}>`,
      value,
    );
  }
  if (field.type === "datetime") {
    const zone = props.timeZone ?? "UTC";
    const value = datetimeFieldValue(field, zone);
    return unit(
      props,
      unitCtx,
      `<input type="datetime-local" name="${nameAttr}" id="${idAttr}" value="${escapeAttr(value)}" class="${cls}"${unitCtx.common}><span>${escapeHtml(zone)}</span>`,
      value,
    );
  }
  throw new Error(
    `field "${field.path}": input needs a text, numeric, date or datetime type, got ${JSON.stringify(field.type)}`,
  );
}

/**
 * Multiline text input. Only textlike types fit; anything else throws,
 * naming the field.
 */
export async function textarea(props: TextareaProps): Promise<string> {
  const modifiers = appearanceClasses("textarea", "textarea", pickAppearance(props));
  const field = props.field;
  assertFieldType(field);
  if (!TEXT_TYPES.has(field.type)) {
    throw new Error(
      `field "${field.path}": textarea needs a text type, got ${JSON.stringify(field.type)}`,
    );
  }
  const unitCtx = unitContext(props);
  const cls = escapeAttr(joinClasses("textarea", modifiers));
  const value = stringFieldValue(field) ?? "";
  return unit(
    props,
    unitCtx,
    `<textarea name="${escapeAttr(unitCtx.name)}" id="${escapeAttr(unitCtx.id)}" class="${cls}"${unitCtx.common}>${escapeHtml(value)}</textarea>`,
    value,
  );
}

// ---------------------------------------------------------------------------
// Boolean units
// ---------------------------------------------------------------------------

/** Boolean checkbox. Non-bool types throw, naming the field. */
export async function checkbox(props: CheckboxProps): Promise<string> {
  const modifiers = appearanceClasses("checkbox", "checkbox", pickAppearance(props));
  const field = props.field;
  assertFieldType(field);
  if (field.type !== "bool") {
    throw new Error(
      `field "${field.path}": checkbox needs a bool type, got ${JSON.stringify(field.type)}`,
    );
  }
  const unitCtx = unitContext(props);
  const cls = escapeAttr(joinClasses("checkbox", modifiers));
  const checked = boolFieldValue(field);
  return unit(
    props,
    unitCtx,
    `<input type="checkbox" name="${escapeAttr(unitCtx.name)}" id="${escapeAttr(unitCtx.id)}" value="true"${checked ? " checked" : ""} class="${cls}"${unitCtx.common}>`,
    checked ? "true" : "false",
  );
}

/** Boolean toggle (same value semantics as checkbox). Non-bool throws. */
export async function toggle(props: ToggleProps): Promise<string> {
  const modifiers = appearanceClasses("toggle", "toggle", pickAppearance(props));
  const field = props.field;
  assertFieldType(field);
  if (field.type !== "bool") {
    throw new Error(
      `field "${field.path}": toggle needs a bool type, got ${JSON.stringify(field.type)}`,
    );
  }
  const unitCtx = unitContext(props);
  const cls = escapeAttr(joinClasses("toggle", modifiers));
  const checked = boolFieldValue(field);
  return unit(
    props,
    unitCtx,
    `<input type="checkbox" name="${escapeAttr(unitCtx.name)}" id="${escapeAttr(unitCtx.id)}" value="true"${checked ? " checked" : ""} class="${cls}"${unitCtx.common}>`,
    checked ? "true" : "false",
  );
}

// ---------------------------------------------------------------------------
// Finite-choice units
// ---------------------------------------------------------------------------

/**
 * Finite-choice radio group. The field needs a non-empty option list;
 * otherwise this throws, naming the field.
 */
export async function radio(props: RadioProps): Promise<string> {
  const modifiers = appearanceClasses("radio", "radio", pickAppearance(props));
  const field = props.field;
  assertFieldType(field);
  const options = requireOptions(field, "radio");
  const unitCtx = unitContext(props);
  const cls = escapeAttr(joinClasses("radio", modifiers));
  const current = stringFieldValue(field);
  const nameAttr = escapeAttr(unitCtx.name);
  const items = options
    .map((option, index) => {
      const optionId = index === 0 ? unitCtx.id : `${unitCtx.id}-${String(index)}`;
      const checked = current !== null && option.value === current ? " checked" : "";
      return (
        `<label><input type="radio" name="${nameAttr}" id="${escapeAttr(optionId)}" ` +
        `value="${escapeAttr(option.value)}"${checked} class="${cls}"${unitCtx.common}>` +
        `${escapeHtml(resolveCaption(option.label, props.context))}</label>`
      );
    })
    .join("");
  return unit(props, unitCtx, `<div role="radiogroup">${items}</div>`, current ?? "");
}

/**
 * Finite-choice select. The field needs a non-empty option list (C4
 * explicit-control suitability is stricter than the S4 default, which
 * accepts an empty list); otherwise this throws, naming the field.
 */
export async function select(props: SelectProps): Promise<string> {
  const modifiers = appearanceClasses("select", "select", pickAppearance(props));
  const field = props.field;
  assertFieldType(field);
  const options = requireOptions(field, "select");
  const unitCtx = unitContext(props);
  const cls = escapeAttr(joinClasses("select", modifiers));
  const current = stringFieldValue(field);
  const items = options
    .map((option) => {
      const selected = current !== null && option.value === current ? " selected" : "";
      return `<option value="${escapeAttr(option.value)}"${selected}>${escapeHtml(resolveCaption(option.label, props.context))}</option>`;
    })
    .join("");
  return unit(
    props,
    unitCtx,
    `<select name="${escapeAttr(unitCtx.name)}" id="${escapeAttr(unitCtx.id)}" class="${cls}"${unitCtx.common}>${items}</select>`,
    current ?? "",
  );
}

/**
 * Finite-choice input with Filter presentation: radio inputs styled as
 * buttons in a `.filter` container (pinned against
 * node_modules/daisyui/components/filter.css). The upstream `filter-reset`
 * input is deliberately omitted: type=reset restores the whole enclosing
 * form and would discard unrelated drafts. The field needs a non-empty
 * option list; otherwise this throws.
 */
export async function filter(props: FilterProps): Promise<string> {
  appearanceClasses("filter", "filter", pickAppearance(props));
  const field = props.field;
  assertFieldType(field);
  const options = requireOptions(field, "filter");
  const unitCtx = unitContext(props);
  const current = stringFieldValue(field);
  const nameAttr = escapeAttr(unitCtx.name);
  const items = options
    .map((option, index) => {
      const optionId = index === 0 ? unitCtx.id : `${unitCtx.id}-${String(index)}`;
      const checked = current !== null && option.value === current ? " checked" : "";
      const ariaLabel = escapeAttr(resolveCaption(option.label, props.context));
      return (
        `<input class="btn" type="radio" name="${nameAttr}" id="${escapeAttr(optionId)}" ` +
        `value="${escapeAttr(option.value)}" aria-label="${ariaLabel}"${checked}${unitCtx.common}>`
      );
    })
    .join("");
  return unit(props, unitCtx, `<div class="filter">${items}</div>`, current ?? "");
}

// ---------------------------------------------------------------------------
// Numeric units
// ---------------------------------------------------------------------------

/**
 * Numeric range slider. Only int/decimal/money types fit; anything else
 * throws, naming the field. FormFieldDef carries no bounds, so no min/max
 * is emitted (contract gap, reported not fixed).
 */
export async function range(props: RangeProps): Promise<string> {
  const modifiers = appearanceClasses("range", "range", pickAppearance(props));
  const field = props.field;
  assertFieldType(field);
  if (!NUMERIC_TYPES.has(field.type)) {
    throw new Error(
      `field "${field.path}": range needs a numeric type, got ${JSON.stringify(field.type)}`,
    );
  }
  const bounds = rangeBounds(field);
  const unitCtx = unitContext(props);
  const cls = escapeAttr(joinClasses("range", modifiers));
  const value = numericFieldValue(field);
  const outOfBounds =
    value !== "" && bounds !== null && !rangeContains(bounds, field, value);
  if (outOfBounds && bounds !== null) {
    const note = escapeHtml(resolveCaption(RANGE_INVALID, props.context));
    // Disabled sliders submit nothing; the hidden duplicate preserves the raw
    // draft (unit() already adds one for readonly fields, so skip it there).
    const preserve = field.readonly === true ? "" : hidden(unitCtx.name, value);
    return unit(
      props,
      unitCtx,
      `<input type="range" name="${escapeAttr(unitCtx.name)}" id="${escapeAttr(unitCtx.id)}" ` +
        `value="${escapeAttr(value)}" min="${escapeAttr(bounds.minText)}" max="${escapeAttr(bounds.maxText)}" ` +
        `class="${cls}"${unitCtx.common} disabled>` +
        `<p role="alert" class="alert alert-error">${note}</p>${preserve}`,
      value,
    );
  }
  const minMax =
    bounds === null
      ? ""
      : ` min="${escapeAttr(bounds.minText)}" max="${escapeAttr(bounds.maxText)}"`;
  return unit(
    props,
    unitCtx,
    `<input type="range" name="${escapeAttr(unitCtx.name)}" id="${escapeAttr(unitCtx.id)}" value="${escapeAttr(value)}" class="${cls}"${minMax}${unitCtx.common}>`,
    value,
  );
}

interface RangeBounds {
  readonly minText: string;
  readonly maxText: string;
  readonly min: number;
  readonly max: number;
}

/**
 * Schema bounds for a range slider. Both min and max must be present finite
 * numbers with min <= max; anything else throws (a half-bounded slider would
 * silently clamp display). Absent bounds render the browser default.
 */
function rangeBounds(field: FormFieldDef): RangeBounds | null {
  if (field.min === undefined && field.max === undefined) {
    return null;
  }
  if (
    typeof field.min !== "number" ||
    typeof field.max !== "number" ||
    !Number.isFinite(field.min) ||
    !Number.isFinite(field.max) ||
    field.min > field.max
  ) {
    throw new Error(
      `field "${field.path}": range needs finite min <= max bounds, got ${String(field.min)}/${String(field.max)}`,
    );
  }
  return { minText: String(field.min), maxText: String(field.max), min: field.min, max: field.max };
}

/** Bounds containment on canonical numeric text (non-finite never displays). */
function rangeContains(bounds: RangeBounds, field: FormFieldDef, value: string): boolean {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`field "${field.path}": range value is not displayable`);
  }
  return n >= bounds.min && n <= bounds.max;
}

/**
 * Five-star rating bound to a numeric value. Only int/decimal/money types
 * fit; anything else throws, naming the field. The checked star is the one
 * whose 1-based position equals the integer value; non-integer or
 * out-of-range drafts leave every star unchecked (never clamped).
 */
export async function rating(props: RatingProps): Promise<string> {
  const modifiers = appearanceClasses("rating", "rating", pickAppearance(props));
  const field = props.field;
  assertFieldType(field);
  if (!NUMERIC_TYPES.has(field.type)) {
    throw new Error(
      `field "${field.path}": rating needs a numeric type, got ${JSON.stringify(field.type)}`,
    );
  }
  const unitCtx = unitContext(props);
  const cls = escapeAttr(joinClasses("rating", modifiers));
  const value = numericFieldValue(field);
  // String-exact star match: Number() would misread huge/near-integer text.
  const current =
    value === "" || !INT_RE.test(value)
      ? ""
      : value.replace(/^\+/, "").replace(/^(-?)0+(?=\d)/, "$1");
  const nameAttr = escapeAttr(unitCtx.name);
  const stars: string[] = [];
  for (let star = 1; star <= RATING_STARS; star += 1) {
    const starId = star === 1 ? unitCtx.id : `${unitCtx.id}-${String(star)}`;
    const checked = current === String(star) ? " checked" : "";
    stars.push(
      `<input type="radio" name="${nameAttr}" id="${escapeAttr(starId)}" value="${String(star)}" ` +
        `aria-label="${String(star)} star${star === 1 ? "" : "s"}" class="mask mask-star"${checked}${unitCtx.common}>`,
    );
  }
  return unit(props, unitCtx, `<div class="${cls}">${stars.join("")}</div>`, value);
}

// ---------------------------------------------------------------------------
// File + OTP units
// ---------------------------------------------------------------------------

/**
 * Writable file input. Only file types fit; anything else throws, naming
 * the field. Upload transport stays in L6/S7: this renders the input alone.
 */
export async function fileInput(props: FileInputProps): Promise<string> {
  const modifiers = appearanceClasses("file_input", "file-input", pickAppearance(props));
  const field = props.field;
  assertFieldType(field);
  if (!(field.type === "file" || field.type.startsWith("file."))) {
    throw new Error(
      `field "${field.path}": file_input needs a file type, got ${JSON.stringify(field.type)}`,
    );
  }
  const unitCtx = unitContext(props);
  const cls = escapeAttr(joinClasses("file-input", modifiers));
  return unit(
    props,
    unitCtx,
    `<input type="file" name="${escapeAttr(unitCtx.name)}" id="${escapeAttr(unitCtx.id)}" class="${cls}"${unitCtx.common}>`,
    "",
  );
}

/**
 * Constrained text input with OTP presentation: one focusable text input
 * (inputmode numeric) in a `.otp` container with visual segment spans
 * (pinned against node_modules/daisyui/components/otp.css). Only textlike
 * types fit and the draft stays a verbatim string, so leading zeros
 * survive; anything else throws, naming the field. The segment count
 * derives from the draft length (1..8) because the contract carries no
 * OTP length (reported gap).
 */
export async function otp(props: OtpProps): Promise<string> {
  const modifiers = appearanceClasses("otp", "otp", pickAppearance(props));
  const field = props.field;
  assertFieldType(field);
  if (!TEXT_TYPES.has(field.type)) {
    throw new Error(
      `field "${field.path}": otp needs a text type, got ${JSON.stringify(field.type)}`,
    );
  }
  const unitCtx = unitContext(props);
  const cls = escapeAttr(joinClasses("otp", modifiers));
  const value = stringFieldValue(field) ?? "";
  const segments = Math.min(OTP_MAX_SEGMENTS, Math.max(1, value.length));
  const spans = "<span></span>".repeat(segments);
  return unit(
    props,
    unitCtx,
    `<div class="${cls}"><input type="text" inputmode="numeric" name="${escapeAttr(unitCtx.name)}" id="${escapeAttr(unitCtx.id)}" value="${escapeAttr(value)}"${unitCtx.common}>${spans}</div>`,
    value,
  );
}

// ---------------------------------------------------------------------------
// Label + validator fragments
// ---------------------------------------------------------------------------

/**
 * This field's label element only: `for` targets the sibling unit's input
 * id, the caption resolves caption ?? labelCaption ?? label, and required
 * fields carry the mark. Renders no widget and no errors.
 */
export async function label(props: LabelProps): Promise<string> {
  appearanceClasses("label", "label", pickAppearance(props));
  assertFieldPath(props.field.path);
  const id = fieldInputId(props.idPrefix, props.field.path);
  const caption: MessageValue = props.caption ?? props.field.labelCaption ?? props.field.label;
  const text = escapeHtml(resolveCaption(caption, props.context));
  const mark = props.field.required ? ` <span aria-hidden="true">*</span>` : "";
  return `<label for="${escapeAttr(id)}" class="label">${text}${mark}</label>`;
}

/**
 * This field's error outlet only: a `<div>` with the sibling unit's outlet
 * id holding this field's filtered errors (each a `<p class="text-error">`),
 * always rendered so the swap target is stable. Renders no label/widget.
 */
export async function validator(props: ValidatorProps): Promise<string> {
  appearanceClasses("validator", "validator", pickAppearance(props));
  assertFieldPath(props.field.path);
  const outlet = fieldErrorOutletId(props.idPrefix, props.field.path);
  const items = ownErrors(props)
    .map((error) => `<p class="text-error">${escapeHtml(error.message)}</p>`)
    .join("");
  return `<div id="${escapeAttr(outlet)}">${items}</div>`;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

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

/** Zoned calendar day (YYYY-MM-DD) for a date or datetime cell value. */
function agendaDayKey(
  value: unknown,
  rowId: string,
  startField: string,
  timeZone: string,
): string {
  if (typeof value === "string" && DATE_RE.test(value) && isValidDate(value)) {
    return value;
  }
  if (typeof value === "string" && DATETIME_RE.test(value) && Number.isFinite(Date.parse(value))) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(value));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `calendar agenda: row "${rowId}" cannot group by day in ${JSON.stringify(timeZone)}: ${reason}`,
      );
    }
  }
  throw new Error(
    `calendar agenda: row "${rowId}" start field "${startField}" needs a date or datetime value`,
  );
}

function agendaCellText(
  value: unknown,
  context: PresentationContext,
  locale: string,
  timeZone: string,
): string {
  if (typeof value === "string" && DATE_RE.test(value) && isValidDate(value)) {
    try {
      return formatScalar({ type: "date", value }, { locale, timeZone });
    } catch {
      return value;
    }
  }
  if (typeof value === "string" && DATETIME_RE.test(value) && Number.isFinite(Date.parse(value))) {
    try {
      return formatScalar({ type: "datetime", value }, { locale, timeZone });
    } catch {
      return value;
    }
  }
  return rawText(value);
}

/** Calendar field control: date/datetime complete unit. */
async function calendarField(props: CalendarProps & { readonly kind: "field" }): Promise<string> {
  appearanceClasses("calendar", "calendar", pickAppearance(props));
  const field = props.field;
  assertFieldType(field);
  if (!TEMPORAL_TYPES.has(field.type)) {
    throw new Error(
      `field "${field.path}": calendar needs a date or datetime type, got ${JSON.stringify(field.type)}`,
    );
  }
  const unitCtx = unitContext(props);
  const nameAttr = escapeAttr(unitCtx.name);
  const idAttr = escapeAttr(unitCtx.id);
  if (field.type === "date") {
    const value = dateFieldValue(field);
    return unit(
      props,
      unitCtx,
      `<input type="date" name="${nameAttr}" id="${idAttr}" value="${escapeAttr(value)}" class="input"${unitCtx.common}>`,
      value,
    );
  }
  const zone = props.timeZone ?? "UTC";
  const value = datetimeFieldValue(field, zone);
  return unit(
    props,
    unitCtx,
    `<input type="datetime-local" name="${nameAttr}" id="${idAttr}" value="${escapeAttr(value)}" class="input"${unitCtx.common}><span>${escapeHtml(zone)}</span>`,
    value,
  );
}

/**
 * Calendar agenda: date-grouped read-only agenda over an authorized query,
 * grouped by the zoned day of startField. Day headings render through
 * formatScalar; item rows carry the row id plus start/end text. No mutation
 * affordances.
 */
async function calendarAgenda(props: CalendarProps & { readonly kind: "agenda" }): Promise<string> {
  appearanceClasses("calendar", "calendar", pickAppearance(props));
  assertFieldPath(props.startField);
  assertFieldPath(props.endField);
  if (
    props.limit !== undefined &&
    (!Number.isInteger(props.limit) || props.limit < 1 || props.limit > MAX_LIMIT)
  ) {
    throw new Error(`calendar: limit must be an integer 1..${String(MAX_LIMIT)}`);
  }
  const result = await props.context.query(props.context.invocation, props.model, {
    ...(props.where === undefined ? {} : { where: props.where }),
    ...(props.limit === undefined ? {} : { limit: props.limit }),
    ...(props.cursor === undefined ? {} : { cursor: props.cursor }),
  });
  if (result.rows.length === 0) {
    return renderState({ context: props.context, kind: "empty", message: props.empty });
  }
  const locale = pageLocale(props.context);
  const zone = props.timeZone ?? "UTC";
  const groups = new Map<string, RowView[]>();
  for (const row of result.rows) {
    const day = agendaDayKey(row.fields[props.startField], row.id, props.startField, zone);
    const list = groups.get(day);
    if (list === undefined) {
      groups.set(day, [row]);
    } else {
      list.push(row);
    }
  }
  const days = [...groups.keys()].sort();
  const sections = days.map((day) => {
    let heading: string;
    try {
      heading = escapeHtml(formatScalar({ type: "date", value: day }, { locale, timeZone: zone }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `calendar agenda: model "${props.model}" cannot render headings in ${JSON.stringify(zone)}: ${reason}`,
      );
    }
    const rows = (groups.get(day) ?? [])
      .map((row) => {
        const start = escapeHtml(agendaCellText(row.fields[props.startField], props.context, locale, zone));
        const end = escapeHtml(agendaCellText(row.fields[props.endField], props.context, locale, zone));
        return `<li><span>${escapeHtml(row.id)}</span> <span>${start} – ${end}</span></li>`;
      })
      .join("");
    return `<section><h2>${heading}</h2><ul>${rows}</ul></section>`;
  });
  return sections.join("");
}

/**
 * Written-shape dispatch: kind "field" is the temporal complete unit,
 * kind "agenda" is the read-only date-grouped collection.
 */
export async function calendar(props: CalendarProps): Promise<string> {
  if (props.kind === "agenda") {
    return calendarAgenda(props);
  }
  return calendarField(props);
}

// ---------------------------------------------------------------------------
// File display (C7)
// ---------------------------------------------------------------------------

/** Declared DeliveryStatus values (services.ts); the membership check below. */
const DELIVERY_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "succeeded",
  "failed",
  "unknown",
  "skipped",
]);

function fileItem(fieldPath: string, file: FileLinkView, context: PresentationContext): string {
  if (file === null || typeof file !== "object" || Array.isArray(file)) {
    throw new TypeError(`field "${fieldPath}": file entries must be objects`);
  }
  if (typeof file.href !== "string") {
    throw new TypeError(`field "${fieldPath}": file href must be a string`);
  }
  if (file.name !== undefined && typeof file.name !== "string") {
    throw new TypeError(`field "${fieldPath}": file name must be a string`);
  }
  if (file.status !== undefined && !DELIVERY_STATUSES.has(file.status)) {
    throw new Error(
      `field "${fieldPath}": file status must be a declared DeliveryStatus, got ${JSON.stringify(file.status)}`,
    );
  }
  let text: string;
  if (file.caption !== undefined) {
    try {
      text = resolveCaption(file.caption, context);
    } catch {
      throw new TypeError(`field "${fieldPath}": file caption must be a message value`);
    }
  } else {
    text = file.name ?? file.href;
  }
  const status =
    file.status === undefined ? "" : ` <span role="status">${escapeHtml(file.status)}</span>`;
  return `<li><a class="link" href="${escapeAttr(safeHref(file.href))}">${escapeHtml(text)}</a>${status}</li>`;
}

/**
 * Read-only display of authorized finalized file/media links: a `<fieldset>`
 * with the field label as legend, one named link per file, the declared
 * delivery status where carried (announced via role=status), and this
 * field's filtered error outlet. Upload stays with fileInput: this renders
 * no input, no form and no endpoint. Only file types fit; anything else
 * throws, naming the field.
 */
export async function fileControl(props: FileProps): Promise<string> {
  // "file" admits no appearance: base classes only; any runtime token throws.
  appearanceClasses("file", "link", pickAppearance(props));
  const field = props.field;
  assertFieldType(field);
  if (!(field.type === "file" || field.type.startsWith("file."))) {
    throw new Error(
      `field "${field.path}": file needs a file type, got ${JSON.stringify(field.type)}`,
    );
  }
  if (!Array.isArray(props.files)) {
    throw new TypeError(`field "${field.path}": file needs a files array`);
  }
  const unitCtx = unitContext(props);
  const legend = `<legend class="fieldset-legend">${escapeHtml(labelText(field, props.context))}</legend>`;
  const body =
    props.files.length === 0
      ? `<p>${escapeHtml(resolveCaption(FILE_UNAVAILABLE, props.context))}</p>`
      : `<ul>${props.files.map((file) => fileItem(field.path, file, props.context)).join("")}</ul>`;
  return `<fieldset>${legend}${body}${unitErrors(props, unitCtx)}</fieldset>`;
}
