/**
 * Pure navigation discovery shaping (lane 05 S2).
 *
 * The lane 6 dispatcher owns admission: it calls `admit` per candidate and
 * supplies one {@link AdmissionOutcome} per candidate. This module only shapes
 * those results into sorted, grouped navigation. No I/O, no `admit` calls.
 */

import type {
  AdmissionOutcome,
  AppearanceOrientation,
  AppearanceSize,
  AppearanceTone,
  AppearanceVariant,
  BreadcrumbsProps,
  ButtonProps,
  DockProps,
  MegamenuProps,
  MenuProps,
  MessageValue,
  NavbarProps,
  NavigationEntry,
  NavigationGroup,
  NavigationResult,
  OwnerLabels,
  PageChildren,
  PageDescriptor,
  PaginationProps,
  PresentationContext,
  ThemeControllerProps,
} from "../../contracts/src/presentation.js";
import { CSRF_FIELD } from "../../contracts/src/presentation.js";
import { appearanceClasses, type AppearanceOpts } from "./appearance.js";
import { escapeAttr, escapeHtml, safeHref } from "./escape.js";
import { assertFieldPath, serializeActionScalar } from "./forms.js";
import { message, resolveCaption } from "./messages.js";

/**
 * Filter declaration-order descriptors down to discovery candidates:
 * drop `nav="none"` pages, drop dynamic routes (path contains "{"), and
 * dedup exact (owner, path) pairs keeping the first occurrence.
 */
export function selectDiscoveryCandidates(
  descriptors: readonly PageDescriptor[],
): PageDescriptor[] {
  const seen = new Set<string>();
  const candidates: PageDescriptor[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.nav === "none") {
      continue;
    }
    if (descriptor.path.includes("{")) {
      continue;
    }
    const key = JSON.stringify([descriptor.owner, descriptor.path]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push(descriptor);
  }
  return candidates;
}

export interface BuildNavigationOptions {
  readonly ownerLabels: OwnerLabels;
  readonly currentPath: string;
  readonly highlightPath?: string;
}

interface AdmittedRecord {
  readonly descriptor: PageDescriptor;
  /** Position in the candidates array (declaration order). */
  readonly index: number;
  readonly order: bigint;
}

/** Static identity of an explicit group: the string itself, or source text. */
function groupIdentity(group: MessageValue): string {
  return typeof group === "string" ? group : group.source;
}

interface GroupAccumulator {
  readonly owner: string;
  readonly explicit: boolean;
  readonly records: AdmittedRecord[];
}

/**
 * Shape admitted candidates into grouped navigation.
 *
 * @throws Error when a candidate has no outcome (dispatcher bug: fail closed).
 */
export function buildNavigation(
  candidates: readonly PageDescriptor[],
  outcomes: ReadonlyMap<PageDescriptor, AdmissionOutcome>,
  options: BuildNavigationOptions,
): NavigationResult {
  const highlight = options.highlightPath ?? options.currentPath;
  let incomplete = false;
  const admitted: AdmittedRecord[] = [];
  candidates.forEach((candidate, index) => {
    const outcome = outcomes.get(candidate);
    if (outcome === undefined) {
      throw new Error(
        `missing admission outcome for candidate ${candidate.owner} ${candidate.path}`,
      );
    }
    if (outcome === "unavailable") {
      incomplete = true;
    }
    if (outcome !== "admitted") {
      return;
    }
    admitted.push({ descriptor: candidate, index, order: candidate.order ?? 0n });
  });
  admitted.sort((a, b) => {
    if (a.order < b.order) {
      return -1;
    }
    if (a.order > b.order) {
      return 1;
    }
    return a.index - b.index;
  });

  // One group stream per owner; within an owner, explicit groups cluster by
  // static identity and group-less entries share the default group. Groups
  // are created in sorted-entry order, so creation order already equals
  // first-entry-sorted-position order.
  const groups = new Map<string, GroupAccumulator>();
  for (const record of admitted) {
    const group = record.descriptor.group;
    const key =
      group === undefined
        ? JSON.stringify([record.descriptor.owner, "default"])
        : JSON.stringify([record.descriptor.owner, "explicit", groupIdentity(group)]);
    let accumulator = groups.get(key);
    if (accumulator === undefined) {
      accumulator = { owner: record.descriptor.owner, explicit: group !== undefined, records: [] };
      groups.set(key, accumulator);
    }
    accumulator.records.push(record);
  }

  const result: NavigationGroup[] = [];
  for (const accumulator of groups.values()) {
    if (accumulator.records.length === 0) {
      continue;
    }
    const first = accumulator.records[0];
    if (first === undefined) {
      continue;
    }
    let caption: MessageValue;
    if (accumulator.explicit) {
      const group = first.descriptor.group;
      if (group === undefined) {
        continue;
      }
      caption = group;
    } else {
      const label = options.ownerLabels.get(accumulator.owner);
      if (label !== undefined) {
        caption = label;
      } else {
        // First-declared (input order) admitted default-group entry's title.
        // Only admitted default-group records exist here, so denied,
        // unavailable, and hidden pages can never supply the fallback.
        let earliest = first;
        for (const record of accumulator.records) {
          if (record.index < earliest.index) {
            earliest = record;
          }
        }
        caption = earliest.descriptor.title;
      }
    }
    const entries: NavigationEntry[] = accumulator.records.map((record) => {
      const active = record.descriptor.path === highlight;
      const description = record.descriptor.description;
      if (description === undefined) {
        return {
          owner: record.descriptor.owner,
          path: record.descriptor.path,
          title: record.descriptor.title,
          active,
        };
      }
      return {
        owner: record.descriptor.owner,
        path: record.descriptor.path,
        title: record.descriptor.title,
        description,
        active,
      };
    });
    result.push({ owner: accumulator.owner, caption, entries });
  }
  return { groups: result, incomplete };
}

// ---------------------------------------------------------------------------
// C6 navigation factories: breadcrumbs, button, dock, megamenu, menu, navbar,
// pagination, themeController.
//
// Pure server-rendered string builders (async to match the sibling-factory
// contract; no h(), hydration or client state). Entries come from authorized
// page descriptors (NavigationEntry/NavigationGroup, as shaped by
// buildNavigation); every caption resolves through resolveCaption and every
// dynamic string is escaped for its sink. Appearance tokens route through
// appearanceClasses() under the word's exact catalog id, so unadmitted
// tokens throw instead of degrading.
//
// Fail-closed rule (C3/C5 precedent): invalid input throws -- empty
// trails/suites, missing required captions/labels, out-of-range pages,
// unknown themes, bad activation ids -- never clamps or invents content.
// Hostile URLs fall back to "#" via safeHref (the link/shell precedent).
//
// Upstream evidence (daisyUI 5.7.47, pinned):
// - breadcrumbs > ul > li; btn/btn-active/btn-disabled + tone/size/variant
//   scale; menu/menu-horizontal/menu-vertical/menu-active + size scale.
// - navbar/navbar-start/navbar-center/navbar-end (base class only).
// - dock/dock-label/dock-active + size scale; active styling also keys off
//   [aria-current] on the item, so items carry both.
// - megamenu with [popovertarget] triggers immediately followed by their
//   [popover] sibling panels (sibling order is load-bearing upstream), one
//   .megamenu-active indicator, at most 10 triggers (nth-of-type anchor
//   support); size scale + megamenu-vertical (horizontal is default).
// - pagination has no upstream component CSS: join + join-item + btn
//   (the collections-internal precedent, made public here).
// - theme-controller is a behavior hook for live CSS/input preview, not a
//   persistence control; the no-JS factory below deliberately does not use
//   it and posts the choice to the caller's postTo path instead.
// Shell-internal menu/navbar markup and collection-internal pagination are
// not imported here; these factories are the public reusable versions.
// ---------------------------------------------------------------------------

/** Shared prev/next/save/cancel chrome (ui.navigation.*): en source + nl variant. */
const CHROME = {
  prev: message("Previous", { nl: "Vorige" }),
  next: message("Next", { nl: "Volgende" }),
  save: message("Save", { nl: "Opslaan" }),
  cancel: message("Cancel", { nl: "Annuleren" }),
};

/**
 * Activation identity for `opens` targets and popover id prefixes: must
 * start with a letter so `#id` fragment links and popovertarget wiring stay
 * valid (the overlays ACTIVATION_ID_RE precedent).
 */
const ACTIVATION_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Pinned data-theme values from themes.css; anything else fails closed. */
const PINNED_THEMES: ReadonlySet<string> = new Set([
  "can-light-blue",
  "can-light-green",
  "can-light-purple",
  "can-dark-blue",
  "can-dark-green",
  "can-dark-purple",
  "can-system-blue",
  "can-system-green",
  "can-system-purple",
]);

/** Upstream megamenu anchor support ends at the 10th trigger. */
const MAX_MEGAMENU_GROUPS = 10;

/** Default count of numbered page buttons in the pagination window. */
const DEFAULT_PAGE_WINDOW = 7;

/** Minimum window: first + last + current + room for two ellipses. */
const MIN_PAGE_WINDOW = 5;

function joinClasses(base: string, modifiers: string): string {
  return modifiers === "" ? base : `${base} ${modifiers}`;
}

/**
 * Collect every appearance key present at runtime (including undeclared
 * extras from JS callers) so appearanceClasses() judges them against the
 * word's admitted matrix: unadmitted tokens throw, never silently drop.
 */
function pickAppearance(props: object): AppearanceOpts {
  const record = props as Record<string, unknown>;
  const opts: {
    tone?: AppearanceTone;
    size?: AppearanceSize;
    variant?: AppearanceVariant;
    orientation?: AppearanceOrientation;
  } = {};
  if (record["tone"] !== undefined) {
    opts.tone = record["tone"] as AppearanceTone;
  }
  if (record["size"] !== undefined) {
    opts.size = record["size"] as AppearanceSize;
  }
  if (record["variant"] !== undefined) {
    opts.variant = record["variant"] as AppearanceVariant;
  }
  if (record["orientation"] !== undefined) {
    opts.orientation = record["orientation"] as AppearanceOrientation;
  }
  return opts;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(value)}">`;
}

function formOpen(postTo: string): string {
  return `<form action="${escapeAttr(safeHref(postTo))}" method="post">`;
}

/** Non-empty string guard for POST targets, operations and captions. */
function requireText(factory: string, field: string, value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${factory} needs a non-empty ${field}`);
  }
  return value;
}

/** Resolved accessible-name guard: an empty label would emit an empty name. */
function requireLabel(factory: string, label: MessageValue, context: PresentationContext): string {
  const text = resolveCaption(label, context);
  if (text === "") {
    throw new Error(`${factory} label must not be empty`);
  }
  return text;
}

function requireEntries(factory: string, entries: readonly NavigationEntry[]): void {
  if (entries.length === 0) {
    throw new Error(`${factory} needs a nonempty entries suite`);
  }
}

/** One menu list item; active entries carry menu-active + aria-current. */
function menuEntry(entry: NavigationEntry, context: PresentationContext): string {
  const title = escapeHtml(resolveCaption(entry.title, context));
  const href = escapeAttr(safeHref(entry.path));
  if (entry.active) {
    return `<li><a href="${href}" class="menu-active" aria-current="page">${title}</a></li>`;
  }
  return `<li><a href="${href}">${title}</a></li>`;
}

/** Await an optional trusted navbar slot; a provided empty suite throws. */
async function renderSlot(side: string, children: PageChildren | undefined): Promise<string> {
  if (children === undefined) {
    return "";
  }
  const kids = typeof children === "function" ? await children() : children;
  if (kids.length === 0) {
    throw new Error(`navbar ${side} slot needs a nonempty suite`);
  }
  return (await Promise.all(kids)).join("");
}

// ---------------------------------------------------------------------------
// breadcrumbs
// ---------------------------------------------------------------------------

/**
 * Derived-ancestry trail. No authored alternative ancestry is accepted and
 * no trail is invented: an empty ancestry throws.
 */
export async function breadcrumbs(props: BreadcrumbsProps): Promise<string> {
  // breadcrumbs admits no appearance matrix: any runtime appearance key
  // throws via the membership check below.
  appearanceClasses("breadcrumbs", "breadcrumbs", pickAppearance(props));
  if (props.ancestry.length === 0) {
    throw new Error("breadcrumbs needs a nonempty ancestry");
  }
  const label = escapeAttr(requireLabel("breadcrumbs", props.label, props.context));
  const last = props.ancestry.length - 1;
  const items = props.ancestry
    .map((entry, index) => {
      const title = escapeHtml(resolveCaption(entry.title, props.context));
      if (index === last) {
        return `<li><span aria-current="page">${title}</span></li>`;
      }
      return `<li><a href="${escapeAttr(safeHref(entry.path))}">${title}</a></li>`;
    })
    .join("");
  return `<nav aria-label="${label}"><div class="breadcrumbs"><ul>${items}</ul></div></nav>`;
}

// ---------------------------------------------------------------------------
// button
// ---------------------------------------------------------------------------

/**
 * Canonical bound control. Caption order: explicit `caption` first, then
 * the action binding's label, then the target URL (the link precedent).
 * `submit` and `opens` have no derivation source at the presentation layer
 * -- the owning form's submit label and the panel declaration's caption are
 * supplied by the caller as `caption`, and omission throws.
 */
export async function button(props: ButtonProps): Promise<string> {
  const modifiers = appearanceClasses("button", "btn", pickAppearance(props));
  const cls = escapeAttr(joinClasses("btn", modifiers));
  // Null counts as absent (the overlays valueOrChildren precedent); a
  // present-but-null binding must never slip into a branch below.
  const bound = [props.action, props.submit, props.target, props.opens].filter(
    (binding) => binding !== undefined && binding !== null,
  ).length;
  if (bound === 0) {
    throw new Error("button needs exactly one of action, submit, target or opens");
  }
  if (bound > 1) {
    throw new Error("button accepts exactly one of action, submit, target or opens");
  }
  const override =
    props.caption === undefined ? undefined : escapeHtml(resolveCaption(props.caption, props.context));
  if (props.action !== undefined && props.action !== null) {
    const binding = props.action;
    requireText("button", "action postTo", binding.postTo);
    requireText("button", "action operation", binding.operation);
    requireText("button", "action operationId", binding.operationId);
    const text = override ?? escapeHtml(resolveCaption(binding.label, props.context));
    let args = "";
    if (binding.inputs !== undefined) {
      for (const key of Object.keys(binding.inputs)) {
        assertFieldPath(key);
        args += hidden(`inputs[${key}]`, serializeActionScalar(key, binding.inputs[key]));
      }
    }
    return (
      formOpen(binding.postTo) +
      hidden("operation", binding.operation) +
      hidden("operation_id", binding.operationId) +
      hidden(CSRF_FIELD, props.context.csrfToken) +
      args +
      `<button type="submit" class="${cls}">${text}</button></form>`
    );
  }
  if (props.submit !== undefined) {
    if (props.submit !== true) {
      throw new Error("button submit must be true when present");
    }
    if (override === undefined) {
      throw new Error("button submit needs a caption from its owning form");
    }
    return `<button type="submit" class="${cls}">${override}</button>`;
  }
  if (props.target !== undefined) {
    requireText("button", "target", props.target);
    const text = override ?? escapeHtml(props.target);
    return `<a class="${cls}" href="${escapeAttr(safeHref(props.target))}">${text}</a>`;
  }
  const opens: unknown = props.opens;
  // Explicit string check first: RE.test(null) coerces to "null", which
  // matches, so a null opens would slip past the pattern alone.
  if (typeof opens !== "string" || !ACTIVATION_ID_RE.test(opens)) {
    throw new Error(`button opens ${JSON.stringify(opens)} must match /^[A-Za-z][A-Za-z0-9_-]*$/`);
  }
  if (override === undefined) {
    throw new Error("button opens needs the panel caption as its caption");
  }
  return `<a class="${cls}" href="#${escapeAttr(opens)}">${override}</a>`;
}

// ---------------------------------------------------------------------------
// menu
// ---------------------------------------------------------------------------

/** Semantic nav list from authorized entries. Empty entries throw. */
export async function menu(props: MenuProps): Promise<string> {
  const modifiers = appearanceClasses("menu", "menu", pickAppearance(props));
  requireEntries("menu", props.entries);
  const label = escapeAttr(requireLabel("menu", props.label, props.context));
  const items = props.entries.map((entry) => menuEntry(entry, props.context)).join("");
  return `<nav aria-label="${label}"><ul class="${escapeAttr(joinClasses("menu", modifiers))}">${items}</ul></nav>`;
}

// ---------------------------------------------------------------------------
// navbar
// ---------------------------------------------------------------------------

/**
 * Shared navigation presentation. Empty entries throw; provided but empty
 * slot suites throw; omitted slots omit their navbar region.
 */
export async function navbar(props: NavbarProps): Promise<string> {
  const modifiers = appearanceClasses("navbar", "navbar", pickAppearance(props));
  requireEntries("navbar", props.entries);
  const label = escapeAttr(requireLabel("navbar", props.label, props.context));
  const start = await renderSlot("start", props.start);
  const end = await renderSlot("end", props.end);
  const items = props.entries.map((entry) => menuEntry(entry, props.context)).join("");
  return (
    `<nav aria-label="${label}"><div class="${escapeAttr(joinClasses("navbar", modifiers))}">` +
    (start === "" ? "" : `<div class="navbar-start">${start}</div>`) +
    `<div class="navbar-center"><ul class="menu menu-horizontal">${items}</ul></div>` +
    (end === "" ? "" : `<div class="navbar-end">${end}</div>`) +
    `</div></nav>`
  );
}

// ---------------------------------------------------------------------------
// dock
// ---------------------------------------------------------------------------

/**
 * Bottom-bar presentation of authorized destinations. Active entries carry
 * dock-active + aria-current. Empty entries throw.
 */
export async function dock(props: DockProps): Promise<string> {
  const modifiers = appearanceClasses("dock", "dock", pickAppearance(props));
  requireEntries("dock", props.entries);
  const label = escapeAttr(requireLabel("dock", props.label, props.context));
  const items = props.entries
    .map((entry) => {
      const title = escapeHtml(resolveCaption(entry.title, props.context));
      const href = escapeAttr(safeHref(entry.path));
      if (entry.active) {
        return `<a href="${href}" class="dock-active" aria-current="page"><span class="dock-label">${title}</span></a>`;
      }
      return `<a href="${href}"><span class="dock-label">${title}</span></a>`;
    })
    .join("");
  return `<nav aria-label="${label}"><div class="${escapeAttr(joinClasses("dock", modifiers))}">${items}</div></nav>`;
}

// ---------------------------------------------------------------------------
// megamenu
// ---------------------------------------------------------------------------

/**
 * Authorized page descriptors with shared responsive behavior. Empty groups,
 * groups without entries, and more than 10 groups (the upstream anchor
 * bound) throw. Triggers are native popover buttons, so keyboard and touch
 * users reach every panel without script.
 */
export async function megamenu(props: MegamenuProps): Promise<string> {
  const modifiers = appearanceClasses("megamenu", "megamenu", pickAppearance(props));
  if (props.groups.length === 0) {
    throw new Error("megamenu needs a nonempty groups suite");
  }
  if (props.groups.length > MAX_MEGAMENU_GROUPS) {
    throw new Error(`megamenu admits at most ${String(MAX_MEGAMENU_GROUPS)} groups`);
  }
  const prefix = props.idPrefix ?? "megamenu";
  if (!ACTIVATION_ID_RE.test(prefix)) {
    throw new Error(`megamenu idPrefix ${JSON.stringify(prefix)} must match /^[A-Za-z][A-Za-z0-9_-]*$/`);
  }
  const label = escapeAttr(requireLabel("megamenu", props.label, props.context));
  const panels = props.groups
    .map((group, index) => {
      if (group.entries.length === 0) {
        throw new Error("megamenu groups need nonempty entries");
      }
      const id = `${prefix}-${String(index)}`;
      const groupCaption = resolveCaption(group.caption, props.context);
      if (groupCaption === "") {
        throw new Error("megamenu group caption must not be empty");
      }
      const caption = escapeHtml(groupCaption);
      const items = group.entries.map((entry) => menuEntry(entry, props.context)).join("");
      // Trigger immediately followed by its popover sibling: the upstream
      // :has(+ [popover]) selector keys off this order.
      return (
        `<button type="button" popovertarget="${escapeAttr(id)}">${caption}</button>` +
        `<div popover id="${escapeAttr(id)}"><ul class="menu" aria-label="${caption}">${items}</ul></div>`
      );
    })
    .join("");
  return (
    `<nav aria-label="${label}"><div class="${escapeAttr(joinClasses("megamenu", modifiers))}">` +
    panels +
    `<div class="megamenu-active" aria-hidden="true"></div></div></nav>`
  );
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

/**
 * Collection page-window navigation built from join + button (no upstream
 * component CSS). First and last pages always show; the window centers on
 * the current page with ellipsis gaps. Out-of-range pages, non-integer
 * counts and windows below 5 throw.
 */
export async function pagination(props: PaginationProps): Promise<string> {
  // pagination admits no appearance matrix: any runtime appearance key
  // throws via the membership check below.
  appearanceClasses("pagination", "join", pickAppearance(props));
  if (typeof props.hrefForPage !== "function") {
    throw new TypeError("pagination hrefForPage must be a function");
  }
  if (!Number.isSafeInteger(props.pages) || props.pages < 1) {
    throw new RangeError(`pagination needs pages >= 1, got ${String(props.pages)}`);
  }
  if (!Number.isSafeInteger(props.page) || props.page < 1 || props.page > props.pages) {
    throw new RangeError(
      `pagination needs 1 <= page <= ${String(props.pages)}, got ${String(props.page)}`,
    );
  }
  const width = props.window ?? DEFAULT_PAGE_WINDOW;
  if (!Number.isSafeInteger(width) || width < MIN_PAGE_WINDOW) {
    throw new RangeError(`pagination needs window >= ${String(MIN_PAGE_WINDOW)}, got ${String(width)}`);
  }
  const hrefFor = (page: number): string => {
    const href = (props.hrefForPage as (page: number) => string)(page);
    if (typeof href !== "string") {
      throw new TypeError("pagination hrefForPage must return a string");
    }
    return escapeAttr(safeHref(href));
  };
  const shown: number[] = [];
  if (props.pages <= width) {
    for (let page = 1; page <= props.pages; page += 1) {
      shown.push(page);
    }
  } else {
    const inner = width - 2;
    const start = Math.min(
      Math.max(props.page - Math.floor(inner / 2), 2),
      props.pages - inner,
    );
    shown.push(1);
    for (let page = start; page < start + inner; page += 1) {
      shown.push(page);
    }
    shown.push(props.pages);
  }
  const numbers: string[] = [];
  let previous = 0;
  for (const page of shown) {
    if (previous !== 0 && page > previous + 1) {
      numbers.push(`<span class="join-item btn btn-disabled" aria-hidden="true">…</span>`);
    }
    if (page === props.page) {
      numbers.push(
        `<a href="${hrefFor(page)}" class="join-item btn btn-active" aria-current="page">${String(page)}</a>`,
      );
    } else {
      numbers.push(`<a href="${hrefFor(page)}" class="join-item btn">${String(page)}</a>`);
    }
    previous = page;
  }
  const prevText = escapeHtml(
    resolveCaption(props.prevLabel ?? CHROME.prev, props.context),
  );
  const nextText = escapeHtml(
    resolveCaption(props.nextLabel ?? CHROME.next, props.context),
  );
  // Disabled ends are type="button" so a collection rendered inside a form
  // can never submit by activating them.
  const prev =
    props.page > 1
      ? `<a href="${hrefFor(props.page - 1)}" class="join-item btn">${prevText}</a>`
      : `<button type="button" class="join-item btn btn-disabled" disabled aria-disabled="true">${prevText}</button>`;
  const next =
    props.page < props.pages
      ? `<a href="${hrefFor(props.page + 1)}" class="join-item btn">${nextText}</a>`
      : `<button type="button" class="join-item btn btn-disabled" disabled aria-disabled="true">${nextText}</button>`;
  const label = escapeAttr(requireLabel("pagination", props.label, props.context));
  return `<nav aria-label="${label}"><div class="join">${prev}${numbers.join("")}${next}</div></nav>`;
}

// ---------------------------------------------------------------------------
// themeController
// ---------------------------------------------------------------------------

/** No-JS theme-choice form. Unknown/duplicate values and unknown `current` throw. */
export async function themeController(props: ThemeControllerProps): Promise<string> {
  // theme_controller admits no appearance matrix: any runtime appearance
  // key throws via the membership check below.
  appearanceClasses("theme_controller", "theme-controller", pickAppearance(props));
  requireText("themeController", "postTo", props.postTo);
  if (props.themes.length === 0) {
    throw new Error("themeController needs a nonempty themes suite");
  }
  const seen = new Set<string>();
  for (const option of props.themes) {
    if (!PINNED_THEMES.has(option.value)) {
      throw new Error(`themeController unknown theme ${JSON.stringify(option.value)}`);
    }
    if (seen.has(option.value)) {
      throw new Error(`themeController duplicate theme ${JSON.stringify(option.value)}`);
    }
    seen.add(option.value);
  }
  if (props.current !== undefined && !seen.has(props.current)) {
    throw new Error(`themeController current ${JSON.stringify(props.current)} is not a listed theme`);
  }
  const label = escapeHtml(requireLabel("themeController", props.label, props.context));
  const options = props.themes
    .map(
      (option) =>
        `<label><input type="radio" class="radio theme-controller" name="theme" value="${escapeAttr(option.value)}"` +
        (option.value === props.current ? " checked" : "") +
        `>${escapeHtml(resolveCaption(option.label, props.context))}</label>`,
    )
    .join("");
  const save = escapeHtml(resolveCaption(CHROME.save, props.context));
  const cancel = escapeHtml(resolveCaption(CHROME.cancel, props.context));
  return (
    formOpen(props.postTo) +
    hidden(CSRF_FIELD, props.context.csrfToken) +
    `<fieldset><legend>${label}</legend><div class="flex flex-col gap-2">${options}</div></fieldset>` +
    `<div class="flex gap-2"><button type="submit" class="btn btn-primary">${save}</button>` +
    `<button type="reset" class="btn btn-ghost">${cancel}</button></div></form>`
  );
}
