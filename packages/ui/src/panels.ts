/**
 * C8 panel factories: tabs, history, copy.
 *
 * Pure async string builders (no h(), hydration or client state). Props live
 * in the presentation contract.
 * Appearance tokens route through appearanceClasses() under the word's exact
 * catalog id, so unadmitted tokens throw instead of degrading. All data is
 * escaped for its sink; captions resolve via resolveCaption.
 *
 * - tabs: upstream radio-driven panels (input.tab[type=radio] + .tab-content
 *   siblings; :checked reveals the panel). Transient selection by default;
 *   an optional owned-enum-preference binding names the radio group after
 *   the preference and wraps the set in a form POSTing to the caller path.
 *   Sizes land on the .tabs container only. tabs-top/bottom are placement
 *   variants upstream, not orientation tokens, so there is no orientation
 *   prop. A nonempty tab-child suite or a selector binding is required.
 * - history: authorized HistoryEntry list as collapse groups inside a list;
 *   operation/actor/time/change plus before/after scalars via formatScalar.
 * - copy: a readonly selectable input holding the value plus its label. No
 *   copy button is rendered: clipboard write needs JS, and a button that
 *   cannot act is dishonest (C5 fab-close precedent: no fab-close exists
 *   because a close control cannot act without JS, so defocus closes).
 *
 * Fail-closed rule (C3 precedent): invalid input throws -- empty suites,
 * unknown bound values, missing POST targets, non-scalar audit values --
 * never clamps or placeholder-swaps silently.
 *
 * Upstream evidence (daisyUI 5.7.47, pinned):
 * - tab/object.js: .tabs container; .tab inputs (aria-label feeds the
 *   visible label via :after); .tab-content revealed by :checked siblings;
 *   .tabs-xs/sm/md/lg/xl size the container; no tone scale.
 * - collapse/object.js: details/summary disclosure (reused via collapse()).
 */

import type {
  CopyProps,
  HistoryProps,
  HistoryEntry,
  MessageParamValue,
  PageChildren,
  PresentationContext,
  TabItem,
  TabsBinding,
  TabsProps,
} from "@canlang/contracts";
import { BUSINESS_ERROR_CODES, CSRF_FIELD } from "@canlang/contracts";
import { appearanceClasses } from "./appearance.js";

import { pickAppearance } from "./internal/appearance-props.js";
import { nativeTextScalar } from "./internal/native-text.js";
import { escapeAttr, escapeHtml, operationPostPath } from "./escape.js";
import { collapse } from "./groups.js";
import {
  canonicalDefaultTag,
  canonicalPreferredTags,
  formatScalar,
  message,
  resolveCaption,
} from "./messages.js";

/** Shared structural captions (ui.panels.*): en source + nl variant. */
const SAVE_LABEL = message("Save", { nl: "Opslaan" });
const BEFORE_LABEL = message("Before", { nl: "Voor" });
const AFTER_LABEL = message("After", { nl: "Na" });
const OPERATION_LABEL = message("Operation", { nl: "Bewerking" });
const ACTOR_LABEL = message("Actor", { nl: "Actor" });
const TIME_LABEL = message("Time", { nl: "Tijd" });
const CHANGE_LABEL = message("Change", { nl: "Wijziging" });
const HISTORY_LABEL = message("History", { nl: "Geschiedenis" });
const HISTORY_EMPTY = message("No history.", { nl: "Geen geschiedenis." });
const HISTORY_UNAVAILABLE = message("History unavailable.", { nl: "Geschiedenis niet beschikbaar." });

/** Default radio-group name when a tabset carries no explicit id. */
const DEFAULT_TABS_NAME = "tabs";

function joinClasses(base: string, modifiers: string): string {
  return modifiers === "" ? base : `${base} ${modifiers}`;
}

/**
 * Stable id fragment. Emitted verbatim (escaped) when provided; anything
 * that is not a non-empty whitespace-free string fails closed.
 */
function idAttr(factory: string, id: string | undefined): string {
  if (id === undefined) {
    return "";
  }
  if (typeof id !== "string" || !/^\S+$/.test(id)) {
    throw new TypeError(`${factory} id must be a non-empty string without whitespace`);
  }
  return ` id="${escapeAttr(id)}"`;
}

/** Non-empty string guard for POST targets, names and values. */
function requireText(factory: string, field: string, value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${factory} needs a non-empty ${field}`);
  }
  return value;
}

/** Await trusted pre-rendered children; empty suites fail closed. */
async function renderKids(factory: string, children: PageChildren): Promise<string> {
  const kids = typeof children === "function" ? await children() : children;
  if (kids.length === 0) {
    throw new Error(`${factory} needs a nonempty content suite`);
  }
  return (await Promise.all(kids)).join("");
}

function pageLocaleOf(context: PresentationContext): string {
  const preferred = canonicalPreferredTags(context.preferredLocales);
  return preferred[0] ?? canonicalDefaultTag(context.appDefaultLocale);
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------

function checkedBinding(factory: string, binding: TabsBinding): Set<string> {
  requireText(factory, "binding name", binding.name);
  requireText(factory, "binding postTo", binding.postTo);
  if (binding.options.length === 0) {
    throw new Error(`${factory} binding needs a nonempty options suite`);
  }
  const seen = new Set<string>();
  for (const option of binding.options) {
    requireText(factory, "option value", option.value);
    if (seen.has(option.value)) {
      throw new Error(`${factory} duplicate option ${JSON.stringify(option.value)}`);
    }
    seen.add(option.value);
  }
  if (binding.current !== undefined && !seen.has(binding.current)) {
    throw new Error(`${factory} current ${JSON.stringify(binding.current)} is not a listed option`);
  }
  return seen;
}

/**
 * Radio-driven tabset. Unbound tabsets keep transient CSS-only selection;
 * a bound tabset names its radios after the owned preference and wraps
 * them in a form POSTing to the caller path. Either a nonempty tab-child
 * suite or a selector binding is required; with both, every rendered
 * item must be a listed option. An option without a rendered panel is a
 * gated-out tab (the compiler statically verifies the authored set
 * corresponds exactly), so the options-to-panels direction only applies
 * to callers that do not report their authored set.
 */
function checkTabsCorrespondence(items: readonly TabItem[], options: ReadonlySet<string>, authored: boolean): void {
  for (const item of items) {
    if (!options.has(item.value)) {
      throw new Error(`tabs item ${JSON.stringify(item.value)} is not a listed option`);
    }
  }
  if (authored) return;
  for (const value of options) {
    if (!items.some((item) => item.value === value) && items.length > 0) {
      throw new Error(`tabs option ${JSON.stringify(value)} has no tab panel`);
    }
  }
}

function tabsSelectorForm(props: TabsProps, binding: TabsBinding, postTo: string, modifiers: string): string {
  // Selector-only bound tabset: no panels, just the preference form.
  const legend =
    props.caption === undefined
      ? ""
      : `<legend>${escapeHtml(resolveCaption(props.caption, props.context))}</legend>`;
  const radios = binding.options
    .map(
      (option) =>
        `<input type="radio" class="tab" name="${escapeAttr(binding.name)}" value="${escapeAttr(option.value)}"` +
        ` aria-label="${escapeAttr(resolveCaption(option.label, props.context))}"` +
        (option.value === binding.current ? " checked" : "") +
        `>`,
    )
    .join("");
  const save = escapeHtml(resolveCaption(SAVE_LABEL, props.context));
  return (
    `<form action="${escapeAttr(postTo)}" method="post" class="can-preference-tabs"${idAttr("tabs", props.id)}>` +
    `<input type="hidden" name="${escapeAttr(CSRF_FIELD)}" value="${escapeAttr(props.context.csrfToken)}">` +
    (binding.version === undefined ? "" : `<input type="hidden" name="_version" value="${escapeAttr(binding.version)}">`) +
    `<fieldset>${legend}<div class="${escapeAttr(joinClasses("tabs tabs-border", modifiers))}">${radios}</div></fieldset>` +
    `<div class="flex gap-2"><button type="submit" class="btn btn-primary" data-can-standard-submit>${save}</button></div></form>`
  );
}

// The binding fallback stays lazy and rereads: like the original `??`
// chain, the current reader runs only when no open item already decides the
// default, and then at each original read site (guard, per-item comparison,
// selected value).
function tabsDefaultValue(items: readonly TabItem[], readCurrent: () => string | undefined): string | undefined {
  const open = items.find((item) => item.open === true)?.value;
  if (open !== null && open !== undefined) return open;
  if (readCurrent() === undefined) return items[0]?.value;
  return items.some((item) => item.value === readCurrent())
    ? readCurrent() as string
    : items[0]?.value;
}

async function tabsPanel(
  item: TabItem,
  index: number,
  context: PresentationContext,
  nameAttr: string,
  idPrefix: string,
  defaultValue: string | undefined,
): Promise<string> {
  requireText("tabs item", "value", item.value);
  const caption = resolveCaption(item.caption, context);
  if (caption === "") {
    throw new Error("tabs item caption must not be empty");
  }
  const body = await renderKids("tabs item", item.children);
  const selected = item.value === defaultValue;
  const panelId = `${idPrefix}-panel-${String(index)}`;
  const tabId = `${idPrefix}-tab-${String(index)}`;
  return (
    `<input type="radio" class="tab" role="tab" id="${escapeAttr(tabId)}" name="${nameAttr}"` +
    ` value="${escapeAttr(item.value)}" aria-label="${escapeAttr(caption)}"` +
    ` aria-selected="${selected ? "true" : "false"}" aria-controls="${escapeAttr(panelId)}"` +
    (selected ? " checked" : "") +
    ` />` +
    `<div class="tab-content" role="tabpanel" id="${escapeAttr(panelId)}" aria-labelledby="${escapeAttr(tabId)}">${body}</div>`
  );
}

function tabsGroupName(props: TabsProps): string {
  const group = props.binding?.name ?? (props.id === undefined ? DEFAULT_TABS_NAME : `tabs-${props.id}`);
  if (props.binding === undefined) {
    requireText("tabs", "radio group name", group);
  }
  return group;
}

function tabsLabel(props: TabsProps): string {
  if (props.caption === undefined) return "";
  const caption = resolveCaption(props.caption, props.context);
  if (caption === "") {
    throw new Error("tabs caption must not be empty");
  }
  return ` aria-label="${escapeAttr(caption)}"`;
}

export async function tabs(props: TabsProps): Promise<string> {
  const modifiers = appearanceClasses("tabs", "tabs", pickAppearance(props));
  const items = props.items ?? [];
  // Authored panels before gates filter: distinguishes all-gated
  // (render the empty tabset) from authored-empty (selector form or
  // authoring error). Absent for legacy/hand-built callers, which
  // keep the strict historical behavior.
  const authored = props.authoredPanels ?? 0;
  if (props.id !== undefined) {
    idAttr("tabs", props.id);
  }
  if (items.length === 0 && props.binding === undefined && authored === 0) {
    throw new Error("tabs needs a nonempty tab-child suite or a selector binding");
  }
  const options = props.binding === undefined ? undefined : checkedBinding("tabs", props.binding);
  if (options !== undefined) {
    checkTabsCorrespondence(items, options, props.authoredPanels !== undefined);
  }
  if (items.filter((item) => item.open === true).length > 1) {
    throw new Error("tabs admits at most one open item");
  }
  const group = tabsGroupName(props);
  const label = tabsLabel(props);

  const postTo = props.binding === undefined ? undefined : operationPostPath(props.binding.postTo);

  if (items.length === 0 && props.binding !== undefined && authored === 0) {
    return tabsSelectorForm(props, props.binding, postTo!, modifiers);
  }

  const nameAttr = escapeAttr(group);
  // Panel/tab element ids namespace under the explicit id when given,
  // else under the radio group name. Two tabsets sharing one prefix
  // (two default sets, or two sets bound to one preference without ids)
  // collide: callers must pass distinct ids (the megamenu rule).
  const idPrefix = props.id ?? group;
  const defaultValue = tabsDefaultValue(items, () => props.binding?.current);
  const panels = await Promise.all(
    items.map(async (item, index) => tabsPanel(item, index, props.context, nameAttr, idPrefix, defaultValue)),
  );
  const setId = props.binding === undefined ? idAttr("tabs", props.id) : "";
  const container = escapeAttr(joinClasses("tabs", modifiers));
  const set =
    `<div class="${container}"${setId} role="tablist"${label}>` +
    panels.join("") +
    `</div>`;
  if (props.binding === undefined) {
    return set;
  }
  const save = escapeHtml(resolveCaption(SAVE_LABEL, props.context));
  return (
    `<form action="${escapeAttr(postTo!)}" method="post"${idAttr("tabs", props.id)}>` +
    `<input type="hidden" name="${escapeAttr(CSRF_FIELD)}" value="${escapeAttr(props.context.csrfToken)}">` +
    (props.binding.version === undefined ? "" : `<input type="hidden" name="_version" value="${escapeAttr(props.binding.version)}">`) +
    set +
    `<div class="flex gap-2"><button type="submit" class="btn btn-primary" data-can-standard-submit>${save}</button></div></form>`
  );
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

/** Map an audit field value onto a scalar param; nested values throw. */
function toScalarParam(field: string, value: unknown): MessageParamValue {
  if (typeof value === "string") {
    return { type: "text", value };
  }
  if (typeof value === "boolean") {
    return { type: "bool", value };
  }
  if (typeof value === "bigint") {
    return { type: "int", value };
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return { type: "int", value };
  }
  if (typeof value === "object" && value !== null) {
    const native = nativeTextScalar(value);
    if (native !== undefined) return native;
  }
  throw new TypeError(`history field ${JSON.stringify(field)} is not a scalar`);
}

function renderRecord(
  record: Readonly<Record<string, unknown>>,
  context: PresentationContext,
): string {
  const locale = pageLocaleOf(context);
  const rows = Object.entries(record).map(([field, value]) => {
    const formatted = value === null ? "" : formatScalar(toScalarParam(field, value), {
      locale,
      timeZone: "UTC",
      ...(context.currencyScales !== undefined ? { currencyScales: context.currencyScales } : {}),
    });
    return `<div><dt>${escapeHtml(field)}</dt><dd>${escapeHtml(formatted)}</dd></div>`;
  });
  return `<dl>${rows.join("")}</dl>`;
}

/**
 * Authorized audit trail: each entry becomes a collapse group titled with
 * its operation, actor and time; the body lists operation/actor/time/change
 * plus before/after field scalars. An empty entry list fails closed: there
 * is no history without entries.
 */
async function renderHistoryEntries(props: Pick<HistoryProps, "context" | "caption" | "id"> & {
  readonly entries: readonly Omit<HistoryEntry, "auditProjection">[];
}): Promise<string> {
  // history admits no appearance matrix: any runtime appearance key throws.
  appearanceClasses("history", "history", pickAppearance(props));
  if (props.id !== undefined) {
    idAttr("history", props.id);
  }
  if (props.entries.length === 0) {
    throw new Error("history needs a nonempty entries suite");
  }
  let label = "";
  if (props.caption !== undefined) {
    const caption = resolveCaption(props.caption, props.context);
    if (caption === "") {
      throw new Error("history caption must not be empty");
    }
    label = ` aria-label="${escapeAttr(caption)}"`;
  }
  const operationLabel = escapeHtml(resolveCaption(OPERATION_LABEL, props.context));
  const actorLabel = escapeHtml(resolveCaption(ACTOR_LABEL, props.context));
  const timeLabel = escapeHtml(resolveCaption(TIME_LABEL, props.context));
  const changeLabel = escapeHtml(resolveCaption(CHANGE_LABEL, props.context));
  const beforeLabel = escapeHtml(resolveCaption(BEFORE_LABEL, props.context));
  const afterLabel = escapeHtml(resolveCaption(AFTER_LABEL, props.context));
  const items = await Promise.all(
    props.entries.map(async (entry) => {
      const at = new Date(entry.at);
      if (!Number.isFinite(at.getTime())) {
        throw new RangeError(`history entry at ${String(entry.at)} is not a valid timestamp`);
      }
      const time = at.toISOString();
      const title = `${entry.operation} — ${entry.actor} — ${time}`;
      const meta =
        `<dl>` +
        `<div><dt>${operationLabel}</dt><dd>${escapeHtml(entry.operation)}</dd></div>` +
        `<div><dt>${actorLabel}</dt><dd>${escapeHtml(entry.actor)}</dd></div>` +
        `<div><dt>${timeLabel}</dt><dd><time datetime="${escapeAttr(time)}">${escapeHtml(time)}</time></dd></div>` +
        `<div><dt>${changeLabel}</dt><dd>${escapeHtml(entry.change)}</dd></div>` +
        `</dl>`;
      const before =
        entry.before === null
          ? ""
          : `<section><h3>${beforeLabel}</h3>${renderRecord(entry.before, props.context)}</section>`;
      const after =
        entry.after === null
          ? ""
          : `<section><h3>${afterLabel}</h3>${renderRecord(entry.after, props.context)}</section>`;
      const group = await collapse({ context: props.context, caption: title, children: [meta + before + after] });
      return `<li>${group}</li>`;
    }),
  );
  return `<ul${idAttr("history", props.id)}${label}>${items.join("")}</ul>`;
}

function historyRowIdentity(props: HistoryProps): { model: string; recordId: string; version: string; record: HistoryProps["record"] } {
  const record = props.record;
  const id = typeof record === "object" && record !== null ? Object.getOwnPropertyDescriptor(record, "id") : undefined;
  const version = typeof record === "object" && record !== null ? Object.getOwnPropertyDescriptor(record, "version") : undefined;
  if (typeof props.model !== "string" || props.model === "" ||
      id === undefined || !("value" in id) || typeof id.value !== "string" || id.value === "" ||
      version === undefined || !("value" in version) || typeof version.value !== "string" || !/^[1-9]\d*$/.test(version.value)) {
    throw new TypeError("history needs an original projected model/row/version");
  }
  return { model: props.model, recordId: id.value, version: version.value, record };
}

async function readSourceHistory(
  props: HistoryProps,
  model: string,
  recordId: string,
  version: string,
  record: HistoryProps["record"],
): Promise<readonly Omit<HistoryEntry, "auditProjection">[] | undefined> {
  if (props.context.readHistory === undefined) return undefined;
  let result;
  let refused = false;
  try {
    result = await props.context.readHistory({ model, record: record! });
  } catch (error) {
    const refusal = typeof error === "object" && error !== null &&
      (("code" in error && BUSINESS_ERROR_CODES.some(code => code === error.code)) ||
        ("name" in error && error.name === "FenceConflictError"));
    if (!refusal) throw error;
    refused = true;
  }
  if (refused) return undefined;
  if (result === undefined || result === null || !Number.isSafeInteger(result.revision) || result.revision < 0 ||
    !Array.isArray(result.entries) || result.entries.some(entry =>
    entry.model !== model || entry.recordId !== recordId || Object.hasOwn(entry, "auditProjection")) ||
    result.entries.length !== 0 && String(result.entries[result.entries.length - 1]!.version) !== version) {
    throw new TypeError("history reader returned an unbound or unprojected result");
  }
  return result.entries;
}

/** Source history consumes only the current admitted scope's projected reader. */
export async function history(props: HistoryProps): Promise<string> {
  if (Object.hasOwn(props, "entries")) {
    if (props.model !== undefined || props.record !== undefined || props.entries === undefined) {
      throw new TypeError("history needs either authorized entries or an original source row");
    }
    return renderHistoryEntries(props);
  }
  appearanceClasses("history", "history", pickAppearance(props));
  const { model, recordId, version, record } = historyRowIdentity(props);
  const entries = await readSourceHistory(props, model, recordId, version, record);
  const body = entries === undefined
    ? `<p role="status" data-can-history="unavailable">${escapeHtml(resolveCaption(HISTORY_UNAVAILABLE, props.context))}</p>`
    : entries.length === 0
      ? `<p role="status" data-can-history="empty">${escapeHtml(resolveCaption(HISTORY_EMPTY, props.context))}</p>`
      : await renderHistoryEntries({ context: props.context, entries });
  return collapse({ context: props.context, caption: props.caption ?? HISTORY_LABEL, children: [body],
    ...(props.id === undefined ? {} : { id: props.id }) });
}

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

/**
 * Selectable value display: a readonly input holding the value plus its
 * label. Readonly (never disabled) keeps the text focusable and selectable
 * with keyboard and pointer alone. There is deliberately no copy button:
 * clipboard write needs JS, and a button that cannot act would be
 * dishonest (C5 fab-close precedent).
 */
export async function copy(props: CopyProps): Promise<string> {
  // copy admits no appearance matrix: any runtime appearance key throws.
  appearanceClasses("copy", "copy", pickAppearance(props));
  if (props.id !== undefined) {
    idAttr("copy", props.id);
  }
  if (typeof props.value !== "string") {
    throw new TypeError("copy value must be a string");
  }
  // A labelless source copies its own value: the displayed value labels
  // itself, so no wording is invented. An explicit empty label still throws.
  const text = props.label === undefined ? props.value : resolveCaption(props.label, props.context);
  if (text === "") {
    throw new Error("copy label must not be empty");
  }
  if (props.id === undefined) {
    return (
      `<label>${escapeHtml(text)}` +
      `<input type="text" class="input" readonly value="${escapeAttr(props.value)}"></label>`
    );
  }
  return (
    `<label for="${escapeAttr(props.id)}">${escapeHtml(text)}</label>` +
    `<input type="text" class="input" id="${escapeAttr(props.id)}" readonly value="${escapeAttr(props.value)}">`
  );
}
