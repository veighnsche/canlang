/**
 * C5 container-group factories: accordion, collapse, fieldset, join, stack,
 * hero, footer, stat, steps, timeline, carousel, diff.
 *
 * Pure server-rendered string builders (async to match the sibling-factory
 * contract; no h(), hydration or client state). Content children arrive as
 * trusted pre-rendered HTML from sibling factories (the card-children
 * precedent); every caption, label, marker and id is resolved through
 * resolveCaption/renderTextValue and escaped for its sink. Appearance tokens
 * route through appearanceClasses() under the word's exact catalog id, so
 * unadmitted tokens throw instead of degrading.
 *
 * Fail-closed rule (C3 precedent): invalid input throws -- empty suites,
 * missing required captions/slots, multiple open accordion items, mixed
 * regular/slot bodies -- never clamps or placeholder-swaps silently.
 *
 * Upstream evidence (daisyUI 5.7.47, pinned):
 * - collapse/collapse-title/collapse-content + details/summary pattern and
 *   the radio-input accordion pattern (no upstream .accordion class, so the
 *   accordion container is the documented join of collapse-arrow items).
 * - fieldset/fieldset-legend, join/join-item, stack, hero/hero-content,
 *   footer/footer-title, stats/stat/stat-figure/stat-title/stat-value/
 *   stat-desc, steps/step/step-<tone>, timeline/timeline-start/middle/end,
 *   carousel/carousel-item, diff/diff-item-1/diff-item-2/diff-resizer.
 * - Orientation modifiers exist for every word that admits orientation
 *   (join/carousel/timeline/steps-horizontal included), so explicit
 *   orientation tokens are kept rather than special-cased.
 */

import type {
  AccordionProps,
  CarouselProps,
  CollapseProps,
  DetailsDrawerProps,
  DiffProps,
  FieldsetProps,
  FooterProps,
  HeroProps,
  JoinProps,
  MessageValue,
  PageChild,
  PageChildren,
  PresentationContext,
  StackProps,
  StatProps,
  StepsProps,
  TextValue,
  TimelineProps,
} from "@canlang/contracts";
import { collectionCursorName } from "@canlang/contracts";
import { appearanceClasses } from "./appearance.js";
import { partitionActionGroups } from "./internal/action-groups.js";
import { pickAppearance } from "./internal/appearance-props.js";
import { selectionHref, selectionCloseHref } from "./internal/collection-selection.js";
import { EMPTY_COLLECTION } from "./collections.js";
import { renderState, renderTextValue } from "./components.js";
import { escapeAttr, escapeHtml } from "./escape.js";
import { message, resolveCaption } from "./messages.js";

/** Accessible names for the diff slots (ui.groups.*): en source + nl variant. */
const DIFF_BEFORE = message("Before", { nl: "Voor" });
const DIFF_AFTER = message("After", { nl: "Na" });

/** Default radio-group name when an accordion carries no explicit id. */
const DEFAULT_ACCORDION_NAME = "accordion";

function joinClasses(base: string, modifiers: string): string {
  return modifiers === "" ? base : `${base} ${modifiers}`;
}

function captionOf(context: PresentationContext, value: MessageValue): string {
  return resolveCaption(value, context);
}

function requireCaption(
  factory: string,
  caption: MessageValue | undefined | null,
): MessageValue {
  if (caption === undefined || caption === null) {
    throw new Error(`${factory} needs a caption`);
  }
  return caption;
}

/**
 * Stable swap-region id. Emitted verbatim (escaped) when provided; anything
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

/** Await trusted pre-rendered children; empty suites fail closed. */
async function renderKids(factory: string, children: PageChildren): Promise<string> {
  const kids = typeof children === "function" ? await children() : children;
  if (kids.length === 0) {
    throw new Error(`${factory} needs a nonempty content suite`);
  }
  return (await Promise.all(kids)).join("");
}

/** Await one trusted pre-rendered slot child. */
async function renderSlot(factory: string, slot: string, child: PageChild): Promise<string> {
  if (child === undefined || child === null) {
    throw new Error(`${factory} needs its ${slot} slot`);
  }
  return await child;
}

function requireValue(factory: string, field: string, value: TextValue): TextValue {
  if (value === null || value === undefined) {
    throw new Error(`${factory} needs a ${field}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// accordion
// ---------------------------------------------------------------------------

/**
 * Single-open disclosure group: one or more collapse items sharing a radio
 * name (the pinned upstream accordion pattern). More than one `open` item
 * fails closed. The radio name derives from `id` when given, so repeated
 * accordions on one page stay independent. An optional caption names the
 * radio group for assistive technology (role=group/aria-label).
 */
export async function accordion(props: AccordionProps): Promise<string> {
  appearanceClasses("accordion", "accordion", pickAppearance(props));
  if (props.items.length === 0) {
    throw new Error("accordion needs at least one collapse item");
  }
  if (props.items.filter((item) => item.open === true).length > 1) {
    throw new Error("accordion admits at most one open item");
  }
  let group = "";
  if (props.caption !== undefined) {
    const name = captionOf(props.context, props.caption);
    if (name === "") {
      throw new Error("accordion caption must not be empty");
    }
    group = ` role="group" aria-label="${escapeAttr(name)}"`;
  }
  const name = escapeAttr(
    props.id === undefined ? DEFAULT_ACCORDION_NAME : `accordion-${props.id}`,
  );
  if (props.id !== undefined) {
    idAttr("accordion", props.id);
  }
  const rendered = await Promise.all(
    props.items.map(async (item) => {
      const title = escapeHtml(
        captionOf(props.context, requireCaption("accordion item", item.caption)),
      );
      const body = await renderKids("accordion item", item.children);
      const checked = item.open === true ? ` checked="checked"` : "";
      return (
        `<div class="collapse collapse-arrow join-item">` +
        `<input type="radio" name="${name}"${checked} />` +
        `<div class="collapse-title">${title}</div>` +
        `<div class="collapse-content">${body}</div></div>`
      );
    }),
  );
  return `<div class="join join-vertical w-full"${idAttr("accordion", props.id)}${group}>${rendered.join("")}</div>`;
}

// ---------------------------------------------------------------------------
// collapse
// ---------------------------------------------------------------------------

const CLOSE_DETAILS = message("Close details", { nl: "Details sluiten" });

/** Source detail body is evaluated only for its activated original row. */
export async function detailsDrawer(props: DetailsDrawerProps): Promise<string> {
  if ("open" in props) throw new TypeError("details drawer cannot take open");
  const caption = escapeHtml(captionOf(props.context, requireCaption("details drawer", props.caption)));
  if (typeof props.occurrence !== "string" || props.occurrence.trim() === "") {
    throw new TypeError("details drawer requires a nonempty source occurrence");
  }
  const idDescriptor = typeof props.record === "object" && props.record !== null
    ? Object.getOwnPropertyDescriptor(props.record, "id") : undefined;
  if (idDescriptor === undefined || !("value" in idDescriptor) ||
      typeof idDescriptor.value !== "string" || idDescriptor.value === "" || typeof props.renderBody !== "function") {
    throw new TypeError("details drawer requires an original row identity and body callback");
  }
  const recordId = idDescriptor.value as string;
  const href = selectionHref(props.context, props.occurrence, recordId);
  const closeHref = selectionCloseHref(props.context, props.occurrence);
  const scope = JSON.stringify([props.context.path, props.occurrence, recordId]);
  const id = `can-details-${Array.from({ length: scope.length }, (_, index) =>
    scope.charCodeAt(index).toString(16).padStart(4, "0")).join("")}`;
  const toggle = `${id}-toggle`, panel = `${id}-panel`, title = `${id}-title`;
  const opener = `<a class="btn drawer-button" href="${escapeAttr(href)}" aria-controls="${panel}">${caption}</a>`;
  if (props.context.collectionSelections?.get(props.occurrence) !== recordId) return opener;
  const children = await props.renderBody(props.record, props.context);
  const kids = typeof children === "function" ? await children() : children;
  const { primary, secondary, body } = partitionActionGroups(await Promise.all(kids));
  const close = escapeHtml(resolveCaption(CLOSE_DETAILS, props.context));
  return `<div class="drawer drawer-end" data-can-split>` +
    `<input id="${toggle}" type="checkbox" class="drawer-toggle" checked aria-label="${caption}" aria-controls="${panel}">` +
    `<div class="drawer-content">${opener}</div><div class="drawer-side">` +
    `<a class="drawer-overlay" href="${escapeAttr(closeHref)}" aria-label="${close}"></a>` +
    `<dialog open data-can-split-panel id="${panel}" aria-labelledby="${title}" class="bg-base-100 min-h-full w-80 p-4" style="max-width:90vw;margin:0;position:relative">` +
    `<header class="can-panel-heading"><h2 id="${title}">${caption}</h2>${secondary}</header><a class="btn" data-can-split-close href="${escapeAttr(closeHref)}">${close}</a>` +
    `${body}${primary === "" ? "" : `<footer>${primary}</footer>`}</dialog></div></div>`;
}

/** Native details/summary disclosure group with a required caption. */
export async function collapse(props: CollapseProps): Promise<string> {
  const modifiers = appearanceClasses("collapse", "collapse", pickAppearance(props));
  const title = escapeHtml(
    captionOf(props.context, requireCaption("collapse", props.caption)),
  );
  const body = await renderKids("collapse", props.children);
  const open = props.open === true ? " open" : "";
  return (
    `<details class="${escapeAttr(joinClasses("collapse", modifiers))}"${open}${idAttr("collapse", props.id)}>` +
    `<summary class="collapse-title">${title}</summary>` +
    `<div class="collapse-content">${body}</div></details>`
  );
}

// ---------------------------------------------------------------------------
// fieldset
// ---------------------------------------------------------------------------

/** Native fieldset group for existing form fields; legend only when captioned. */
export async function fieldset(props: FieldsetProps): Promise<string> {
  const modifiers = appearanceClasses("fieldset", "fieldset", pickAppearance(props));
  const legend =
    props.caption === undefined
      ? ""
      : `<legend class="fieldset-legend">${escapeHtml(captionOf(props.context, props.caption))}</legend>`;
  const body = await renderKids("fieldset", props.children);
  return (
    `<fieldset class="${escapeAttr(joinClasses("fieldset", modifiers))}"${idAttr("fieldset", props.id)}>` +
    `${legend}${body}</fieldset>`
  );
}

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

/**
 * Visual grouping of existing controls. Child factories own their own
 * `join-item` membership; this factory only owns the container.
 */
export async function join(props: JoinProps): Promise<string> {
  const modifiers = appearanceClasses("join", "join", pickAppearance(props));
  const body = await renderKids("join", props.children);
  return `<div class="${escapeAttr(joinClasses("join", modifiers))}"${idAttr("join", props.id)}>${body}</div>`;
}

// ---------------------------------------------------------------------------
// stack
// ---------------------------------------------------------------------------

/** Visual stacking of scoped content. */
export async function stack(props: StackProps): Promise<string> {
  appearanceClasses("stack", "stack", pickAppearance(props));
  const body = await renderKids("stack", props.children);
  return `<div class="stack"${idAttr("stack", props.id)}>${body}</div>`;
}

// ---------------------------------------------------------------------------
// hero
// ---------------------------------------------------------------------------

/**
 * Prominent scoped content group: either a compact children suite or the
 * closed start/content/end slot schema, never both and never neither. The
 * caption renders as the page h1; pages should carry a single hero.
 */
export async function hero(props: HeroProps): Promise<string> {
  const modifiers = appearanceClasses("hero", "hero", pickAppearance(props));
  if (props.children !== undefined && props.slots !== undefined) {
    throw new Error("hero takes either children or slots, not both");
  }
  let body: string;
  if (props.slots !== undefined) {
    const start =
      props.slots.start === undefined
        ? ""
        : `<div>${await renderSlot("hero", "start", props.slots.start)}</div>`;
    const content = `<div>${await renderSlot("hero", "content", props.slots.content)}</div>`;
    const end =
      props.slots.end === undefined
        ? ""
        : `<div>${await renderSlot("hero", "end", props.slots.end)}</div>`;
    body = `${start}${content}${end}`;
  } else if (props.children !== undefined) {
    body = `<div>${await renderKids("hero", props.children)}</div>`;
  } else {
    throw new Error("hero needs either children or slots");
  }
  const heading =
    props.caption === undefined
      ? ""
      : `<h1 class="text-3xl font-bold">${escapeHtml(captionOf(props.context, props.caption))}</h1>`;
  return (
    `<section class="${escapeAttr(joinClasses("hero", modifiers))}"${idAttr("hero", props.id)}>` +
    `<div class="hero-content">${heading}${body}</div></section>`
  );
}

// ---------------------------------------------------------------------------
// footer
// ---------------------------------------------------------------------------

/**
 * Page footer group: either a compact children suite or the closed
 * start/content/end slot schema, never both and never neither.
 */
export async function footer(props: FooterProps): Promise<string> {
  const modifiers = appearanceClasses("footer", "footer", pickAppearance(props));
  if (props.children !== undefined && props.slots !== undefined) {
    throw new Error("footer takes either children or slots, not both");
  }
  let body: string;
  if (props.slots !== undefined) {
    const start =
      props.slots.start === undefined
        ? ""
        : `<div>${await renderSlot("footer", "start", props.slots.start)}</div>`;
    const content = `<div>${await renderSlot("footer", "content", props.slots.content)}</div>`;
    const end =
      props.slots.end === undefined
        ? ""
        : `<div>${await renderSlot("footer", "end", props.slots.end)}</div>`;
    body = `${start}${content}${end}`;
  } else if (props.children !== undefined) {
    body = await renderKids("footer", props.children);
  } else {
    throw new Error("footer needs either children or slots");
  }
  const title =
    props.caption === undefined
      ? ""
      : `<span class="footer-title">${escapeHtml(captionOf(props.context, props.caption))}</span>`;
  return `<footer class="${escapeAttr(joinClasses("footer", modifiers))}"${idAttr("footer", props.id)}>${title}${body}</footer>`;
}

// ---------------------------------------------------------------------------
// stat
// ---------------------------------------------------------------------------

/**
 * Typed metric presentation: required value plus the optional title /
 * description / icon slots. Orientation applies to the upstream `.stats`
 * container, which always wraps the single stat.
 */
export async function stat(props: StatProps): Promise<string> {
  const modifiers = appearanceClasses("stat", "stats", pickAppearance(props));
  const value = renderTextValue(requireValue("stat", "value", props.value), props.context);
  const title =
    props.title === undefined
      ? ""
      : `<div class="stat-title">${escapeHtml(captionOf(props.context, props.title))}</div>`;
  const description =
    props.description === undefined
      ? ""
      : `<div class="stat-desc">${escapeHtml(captionOf(props.context, props.description))}</div>`;
  const figure =
    props.icon === undefined
      ? ""
      : `<div class="stat-figure">${await renderSlot("stat", "icon", props.icon)}</div>`;
  return (
    `<div class="${escapeAttr(joinClasses("stats", modifiers))}"${idAttr("stat", props.id)}>` +
    `<div class="stat">${figure}${title}<div class="stat-value">${value}</div>${description}</div></div>`
  );
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

/**
 * Ordered process stages as a semantic list. Tones live on `.step-*` items
 * only: a top-level tone fails closed rather than emitting the nonexistent
 * `steps-<tone>` class.
 */
export async function steps(props: StepsProps): Promise<string> {
  const record = props as unknown as Record<string, unknown>;
  if (record["tone"] !== undefined) {
    throw new Error("steps admits tone on items only, not on the container");
  }
  const modifiers = appearanceClasses("steps", "steps", pickAppearance(props));
  if (props.items.length === 0) {
    throw new Error("steps needs at least one item");
  }
  const rendered = props.items.map((item) => {
    const itemRecord = item as unknown as Record<string, unknown>;
    if (itemRecord["size"] !== undefined || itemRecord["variant"] !== undefined || itemRecord["orientation"] !== undefined) {
      throw new Error("step items admit tone only");
    }
    const toneModifiers = appearanceClasses(
      "steps",
      "step",
      item.tone === undefined ? {} : { tone: item.tone },
    );
    if (item.marker !== undefined && typeof item.marker !== "string") {
      throw new TypeError("step marker must be a string");
    }
    const marker =
      item.marker === undefined ? "" : ` data-content="${escapeAttr(item.marker)}"`;
    const label = renderTextValue(requireValue("step", "label", item.label), props.context);
    return `<li class="${escapeAttr(joinClasses("step", toneModifiers))}"${marker}>${label}</li>`;
  });
  return `<ol class="${escapeAttr(joinClasses("steps", modifiers))}"${idAttr("steps", props.id)}>${rendered.join("")}</ol>`;
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

/**
 * Ordered entries as a semantic list. Every entry needs at least a start or
 * an end; connectors follow the pinned docs pattern (leading `<hr>` except
 * on the first entry, trailing `<hr>` except on the last).
 *
 * Collection mode (`model` + `renderRow`) serves a bound sequence: one
 * `slot item` template rendered once per admitted query row. Each row body
 * becomes its entry's `end` (row bodies are event content; `start` stays
 * reserved for timestamps). Empty results render the shared empty state;
 * query and row-body failures propagate untouched.
 */
export async function timeline(props: TimelineProps): Promise<string> {
  if (props.model !== undefined) {
    return timelineCollection(props);
  }
  return timelineItems(props);
}

/** Collection page-size bound: default 25 (runner), max 100, reject overflow. */
const TIMELINE_MAX_LIMIT = 100;

const TIMELINE_MORE_ROWS = message("More rows available.", {
  nl: "Meer rijen beschikbaar.",
});

/** The dispatcher supplies the current same-app path/query for GET controls. */
function timelinePageUrl(context: PresentationContext): URL {
  const current = context.pollUrl ?? context.path;
  if (!current.startsWith("/") || current.startsWith("//") || /[\\\s\u0000-\u001f\u007f#]/.test(current)) {
    throw new TypeError("Collection pagination requires a same-app relative URL.");
  }
  const url = new URL(current, "https://can.invalid");
  if (url.pathname.startsWith("//")) throw new TypeError("Invalid collection pagination URL.");
  return url;
}

function timelineCursor(props: Pick<TimelineProps, "context" | "cursor" | "page" | "occurrence">): string | undefined {
  if (props.cursor !== undefined || props.page !== true || props.occurrence === undefined) return props.cursor;
  if (props.occurrence.trim() === "") throw new TypeError("Collection pagination requires a nonempty source occurrence.");
  const values = timelinePageUrl(props.context).searchParams.getAll(collectionCursorName(props.occurrence));
  if (values.length > 1 || values[0] === "") {
    throw new TypeError("Collection pagination requires one nonempty occurrence cursor.");
  }
  return values[0];
}

/** Trailing more-note when the runner reports another page. */
function timelineMoreNote(props: Pick<TimelineProps, "context" | "page" | "occurrence">, nextCursor: string | undefined): string {
  if (nextCursor === undefined) return "";
  const caption = escapeHtml(resolveCaption(TIMELINE_MORE_ROWS, props.context));
  if (props.page === true && props.occurrence !== undefined) {
    if (nextCursor === "") return "";
    const url = timelinePageUrl(props.context);
    url.searchParams.set(collectionCursorName(props.occurrence), nextCursor);
    return `<p class="can-more" data-cursor="${escapeAttr(nextCursor)}"><a rel="next" href="${escapeAttr(url.pathname + url.search)}">${caption}</a></p>`;
  }
  return `<p class="can-more" data-cursor="${escapeAttr(nextCursor)}">${caption}</p>`;
}

function checkTimelineLimit(props: TimelineProps): void {
  if (
    props.limit !== undefined &&
    (!Number.isInteger(props.limit) || props.limit < 1 || props.limit > TIMELINE_MAX_LIMIT)
  ) {
    throw new Error(`timeline: limit must be an integer 1..${String(TIMELINE_MAX_LIMIT)}`);
  }
}

async function timelineCollection(props: TimelineProps): Promise<string> {
  const model = props.model as string;
  if (model.trim() === "") throw new Error("timeline: model must be a nonempty model name");
  if (props.items !== undefined) throw new Error("timeline: items and model must not be combined");
  const renderRow = props.renderRow;
  if (renderRow === undefined) throw new Error("timeline: a bound sequence needs renderRow");
  checkTimelineLimit(props);
  const cursor = timelineCursor(props);
  const result = await props.context.query(props.context.invocation, model, {
    ...(props.parent === undefined ? {} : { parent: props.parent }),
    ...(props.where === undefined ? {} : { where: props.where }),
    ...(props.order === undefined ? {} : { order: props.order }),
    ...(props.limit === undefined ? {} : { limit: props.limit }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(props.page === undefined ? {} : { page: props.page }),
    ...(props.occurrence === undefined ? {} : { occurrence: props.occurrence }),
  });
  if (result.rows.length === 0) {
    return renderState({ context: props.context, kind: "empty", message: props.empty ?? EMPTY_COLLECTION });
  }
  const items: { readonly end: PageChild }[] = [];
  for (const row of result.rows) {
    const children = await renderRow(row, props.context);
    const parts = typeof children === "function" ? await children() : children;
    items.push({ end: (await Promise.all(parts)).join("") });
  }
  return (await timelineItems({ context: props.context, items,
    ...(props.orientation === undefined ? {} : { orientation: props.orientation }),
    ...(props.id === undefined ? {} : { id: props.id }) })) + timelineMoreNote(props, result.nextCursor);
}

async function timelineItems(props: TimelineProps): Promise<string> {
  const items = props.items;
  const modifiers = appearanceClasses("timeline", "timeline", pickAppearance(props));
  if (items === undefined || items.length === 0) {
    throw new Error("timeline needs at least one item");
  }
  const rendered = await Promise.all(
    items.map(async (item, index) => {
      if (
        (item.start === undefined || item.start === null) &&
        (item.end === undefined || item.end === null)
      ) {
        throw new Error("timeline items need at least a start or an end");
      }
      const start =
        item.start === undefined || item.start === null
          ? ""
          : `<div class="timeline-start">${await item.start}</div>`;
      const middle = `<div class="timeline-middle">${item.middle === undefined || item.middle === null ? "" : await item.middle}</div>`;
      const end =
        item.end === undefined || item.end === null
          ? ""
          : `<div class="timeline-end">${await item.end}</div>`;
      const lead = index === 0 ? "" : "<hr />";
      const trail = index === items.length - 1 ? "" : "<hr />";
      return `<li>${lead}${start}${middle}${end}${trail}</li>`;
    }),
  );
  return `<ul class="${escapeAttr(joinClasses("timeline", modifiers))}"${idAttr("timeline", props.id)}>${rendered.join("")}</ul>`;
}

// ---------------------------------------------------------------------------
// carousel
// ---------------------------------------------------------------------------

/** Ordered readable content with explicit item slots. */
export async function carousel(props: CarouselProps): Promise<string> {
  const modifiers = appearanceClasses("carousel", "carousel", pickAppearance(props));
  if (props.items.length === 0) {
    throw new Error("carousel needs at least one item");
  }
  const rendered = await Promise.all(
    props.items.map(async (item, index) => {
      if (item === undefined || item === null) {
        throw new Error(`carousel item ${String(index)} is missing`);
      }
      return `<div class="carousel-item">${await item}</div>`;
    }),
  );
  return `<div class="${escapeAttr(joinClasses("carousel", modifiers))}"${idAttr("carousel", props.id)}>${rendered.join("")}</div>`;
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

/**
 * Two-slot before/after presentation (no automatic business comparison).
 * Focusable with localized accessible names per slot.
 */
export async function diff(props: DiffProps): Promise<string> {
  appearanceClasses("diff", "diff", pickAppearance(props));
  const before = await renderSlot("diff", "before", props.before);
  const after = await renderSlot("diff", "after", props.after);
  const beforeLabel = escapeAttr(captionOf(props.context, DIFF_BEFORE));
  const afterLabel = escapeAttr(captionOf(props.context, DIFF_AFTER));
  return (
    `<figure class="diff"${idAttr("diff", props.id)}>` +
    `<div class="diff-item-1" role="img" tabindex="0" aria-label="${beforeLabel}">${before}</div>` +
    `<div class="diff-item-2" role="img" tabindex="0" aria-label="${afterLabel}">${after}</div>` +
    `<div class="diff-resizer"></div></figure>`
  );
}
