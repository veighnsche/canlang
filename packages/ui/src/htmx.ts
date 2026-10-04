/**
 * HTMX fragment attributes and read-region wrappers (S5: interaction).
 *
 * Pure attribute builders plus async region/poll/stale factories. All URLs
 * come from the dispatcher (never invented here) and pass through safeHref;
 * every interpolated string passes through escapeHtml/escapeAttr. Region ids
 * are validated against the canonical kebab shape so forbidden values can
 * never enter markup.
 *
 * HTMX 4 explicit inheritance: regions carry their own id, data-region
 * marker and hx-swap default; no inherited hx-* attributes are emitted.
 */

import type {
  FragmentRegionProps,
  HtmxRequest,
  PageChildren,
  PollProps,
  StaleMarkerProps,
  StatusSwap,
  SwapStrategy,
} from "../../contracts/src/presentation.js";
import { escapeAttr, escapeHtml, safeHref } from "./escape.js";
import { resolveCaption } from "./messages.js";

// Note: no CHROME caption table. All user-visible text here arrives as
// MessageValue props (region label, stale message) and resolves through
// resolveCaption, so there is no caller-independent wording to catalog under
// "ui.htmx.*". A future static badge lead would follow the shell.ts CHROME
// pattern (en source + nl variants) and move to the shared runtime catalog.

/** Canonical lane-05 swap vocabulary mapped to HTMX 4 strategies. */
const SWAP_ATTRS: Record<SwapStrategy, string> = {
  morph: "outerMorph",
  replace: "outerHTML",
  append: "beforeend",
  prepend: "afterbegin",
  none: "none",
};

/** Canonical automatic-region id shape (kebab-case, lowercase alphanumerics). */
const REGION_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Per-status swap selector: exact code ("422") or class wildcard ("5xx"). */
const STATUS_RE = /^(?:\d{3}|[1-5]xx)$/;

/** HTMX extended target keywords allowed besides "#" selectors. */
const EXTENDED_TARGET_RE = /^(?:this|(?:closest|find|next|previous)\s+\S[\s\S]*)$/;

/** Poll/refresh cadence bounds in seconds (DESIGN poll bounds). */
const MIN_INTERVAL_SECONDS = 1;
const MAX_INTERVAL_SECONDS = 3600;

/** Canonical region-id guard, shared with collection regions. */
export function assertRegionId(regionId: string): void {
  if (typeof regionId !== "string" || !REGION_ID_RE.test(regionId)) {
    throw new Error(
      `invalid region id ${JSON.stringify(regionId)}: must match /^[a-z0-9]+(-[a-z0-9]+)*$/`,
    );
  }
}

function assertTarget(target: string, name: string): void {
  if (typeof target !== "string" || target === "") {
    throw new Error(`${name} must be a non-empty selector`);
  }
  if (target.startsWith("#")) {
    if (target.length < 2) {
      throw new Error(`${name} ${JSON.stringify(target)}: "#" selector needs an id`);
    }
    return;
  }
  if (!EXTENDED_TARGET_RE.test(target)) {
    throw new Error(
      `${name} ${JSON.stringify(target)}: must start with "#" or be an hx extended selector (this/closest/find/next/previous)`,
    );
  }
}

function assertStatus(status: string): void {
  if (typeof status !== "string" || !STATUS_RE.test(status)) {
    throw new Error(
      `invalid status selector ${JSON.stringify(status)}: expected /^(?:\\d{3}|[1-5]xx)$/`,
    );
  }
}

function assertIntervalSeconds(intervalSeconds: number, name: string): void {
  if (!Number.isInteger(intervalSeconds)) {
    throw new Error(`${name} must be an integer number of seconds`);
  }
  if (intervalSeconds < MIN_INTERVAL_SECONDS || intervalSeconds > MAX_INTERVAL_SECONDS) {
    throw new Error(
      `${name} ${intervalSeconds} out of bounds: expected ${MIN_INTERVAL_SECONDS}..${MAX_INTERVAL_SECONDS} seconds`,
    );
  }
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function swapAttr(swap: SwapStrategy): string {
  const mapped = SWAP_ATTRS[swap];
  if (mapped === undefined) {
    throw new Error(`unknown swap strategy ${JSON.stringify(swap)}`);
  }
  return mapped;
}

function statusSwapAttr(entry: StatusSwap): string {
  assertStatus(entry.status);
  assertTarget(entry.target, "statusSwaps target");
  let value = `target:${entry.target} swap:${swapAttr(entry.swap)}`;
  if (entry.select !== undefined) {
    assertNonEmptyString(entry.select, "statusSwaps select");
    value += ` select:${entry.select}`;
  }
  return `hx-status:${entry.status}="${escapeAttr(value)}"`;
}

async function renderChildren(children: PageChildren): Promise<string> {
  const list = typeof children === "function" ? await children() : children;
  return (await Promise.all(list)).join("");
}

/**
 * Render a declarative HTMX request as escaped hx-* attributes. Deterministic
 * order: hx-get/hx-post, hx-target, hx-swap (when given), hx-trigger,
 * hx-indicator, hx-include, hx-status:* entries, hx-push-url. The swap
 * default lives on the region (outerMorph), so an absent `swap` emits no
 * hx-swap attribute.
 */
export function hxAttrs(req: HtmxRequest): string {
  if (req.method !== "get" && req.method !== "post") {
    throw new Error(`invalid htmx method ${JSON.stringify(req.method)}: expected "get" or "post"`);
  }
  assertNonEmptyString(req.href, "href");
  assertTarget(req.target, "target");
  const attrs: string[] = [];
  const verb = req.method === "get" ? "hx-get" : "hx-post";
  attrs.push(`${verb}="${escapeAttr(safeHref(req.href))}"`);
  attrs.push(`hx-target="${escapeAttr(req.target)}"`);
  if (req.swap !== undefined) {
    attrs.push(`hx-swap="${escapeAttr(swapAttr(req.swap))}"`);
  }
  if (req.trigger !== undefined) {
    assertNonEmptyString(req.trigger, "trigger");
    attrs.push(`hx-trigger="${escapeAttr(req.trigger)}"`);
  }
  if (req.indicator !== undefined) {
    assertNonEmptyString(req.indicator, "indicator");
    attrs.push(`hx-indicator="${escapeAttr(req.indicator)}"`);
  }
  if (req.include !== undefined) {
    assertTarget(req.include, "include");
    attrs.push(`hx-include="${escapeAttr(req.include)}"`);
  }
  for (const entry of req.statusSwaps ?? []) {
    attrs.push(statusSwapAttr(entry));
  }
  if (req.pushUrl === true) {
    attrs.push(`hx-push-url="true"`);
  }
  return attrs.join(" ");
}

/**
 * Automatic read-region wrapper: stable id + data-region marker + morph
 * default + stale styling hook. Carries no inherited hx-* attributes (htmx4
 * explicit inheritance); content is awaited via PageChildren.
 */
export async function fragmentRegion(props: FragmentRegionProps): Promise<string> {
  assertRegionId(props.regionId);
  const label = escapeAttr(resolveCaption(props.label, props.context));
  const body = await renderChildren(props.content);
  const id = escapeAttr(props.regionId);
  return (
    `<section id="${id}" data-region="${id}" class="can-region" ` +
    `aria-label="${label}" hx-swap="outerMorph">${body}</section>`
  );
}

/**
 * Poll declaration: hidden empty trigger issuing an authorized GET reread of
 * one region at a fixed cadence. One outstanding reread per region via
 * hx-sync="this:abort" (DESIGN); poll pausing while the page is inactive is
 * runtime/browser behavior, not expressible in markup.
 */
export async function pollTrigger(props: PollProps): Promise<string> {
  assertRegionId(props.regionId);
  assertNonEmptyString(props.href, "href");
  assertIntervalSeconds(props.intervalSeconds, "intervalSeconds");
  const href = escapeAttr(safeHref(props.href));
  const target = escapeAttr(`#${props.regionId}`);
  const trigger = escapeAttr(`every ${props.intervalSeconds}s`);
  return (
    `<div hidden aria-hidden="true" hx-get="${href}" hx-target="${target}" ` +
    `hx-trigger="${trigger}" hx-swap="outerMorph" hx-sync="this:abort"></div>`
  );
}

/**
 * Failed/stale read marker left on a region after a correctable reread
 * failure. The dispatcher inserts it (with its composed message) to mark the
 * stale region; role="alert" announces it to assistive tech.
 */
export async function staleMarker(props: StaleMarkerProps): Promise<string> {
  assertRegionId(props.regionId);
  const region = escapeAttr(props.regionId);
  const text = escapeHtml(resolveCaption(props.message, props.context));
  return (
    `<div role="alert" class="badge badge-warning" ` +
    `data-stale-region="${region}">${text}</div>`
  );
}

/**
 * Canonical per-status fragment swaps for a form region target.
 *
 * Rationale (codes/statuses per wire.ts BUSINESS_ERROR_HTTP_STATUS):
 * - 400 (validation) and 422 (rule_failed): morph the form region so field
 *   errors and drafts re-render in place.
 * - 409 (conflict): morph the form region so current values and the conflict
 *   banner render in place.
 * - 5xx (busy 503, delivery_unknown 502 and any other server failure) and
 *   429 (limit): swap "none" so the response never wipes user input; the
 *   dispatcher surfaces these as banners/toasts instead.
 *
 * 403 (forbidden) and 404 (not_found) have no entry: they are full
 * navigations (sign-in/denial/not-found page), never fragment swaps.
 */
export function validationStatusSwaps(formRegionTarget: string): StatusSwap[] {
  assertTarget(formRegionTarget, "formRegionTarget");
  return [
    { status: "400", target: formRegionTarget, swap: "morph" },
    { status: "422", target: formRegionTarget, swap: "morph" },
    { status: "409", target: formRegionTarget, swap: "morph" },
    { status: "5xx", target: formRegionTarget, swap: "none" },
    { status: "429", target: formRegionTarget, swap: "none" },
  ];
}

/**
 * Refresh trigger value for an explicit-first reread cadence: `every {N}s`.
 *
 * DESIGN refresh contract (documented, enforced by the dispatcher/runtime):
 * an explicit user submit happens first; repeats stay on the same
 * page/principal/team; every repeat carries CSRF; one outstanding reread via
 * hx-sync="this:abort". The owning operation is identified by the form the
 * trigger is attached to, so this helper takes only the cadence.
 */
export function refreshTrigger(intervalSeconds: number): string {
  assertIntervalSeconds(intervalSeconds, "intervalSeconds");
  return `every ${intervalSeconds}s`;
}
