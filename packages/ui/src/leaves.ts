/**
 * C3 readable leaf factories: badge, status, kbd, mockupCode, countdown,
 * divider, link.
 *
 * Each factory takes contract props and returns escaped HTML. Appearance
 * modifiers come only from appearanceClasses() under the word's exact
 * catalog id, so unadmitted tokens throw instead of degrading. All base
 * classes and modifiers below are pinned against daisyUI upstream
 * (node_modules/daisyUI/components/<word>/object.js):
 * badge (tones, sizes, outline/soft/ghost), status (tones, sizes), kbd
 * (sizes), link (tones), divider (tones, horizontal/vertical), countdown
 * and mockup-code (base class only).
 *
 * Divider orientation documents an upstream nuance: the default horizontal
 * divider needs no modifier class, but appearanceClasses() emits
 * `divider-horizontal` explicitly when orientation="horizontal" is passed.
 * That class exists upstream and is visually identical to the default, so
 * the explicit token is kept rather than special-cased.
 *
 * Countdown is view-only: it renders the integer part of `value`
 * (Math.floor) into the upstream `--value` custom property and schedules
 * no timers. kbd renders notation only and registers no handlers.
 * mockupCode escapes every line and never interprets content.
 */

import type {
  BadgeProps,
  CountdownProps,
  DividerProps,
  KbdProps,
  LinkProps,
  MockupBrowserProps,
  MockupCodeProps,
  MockupPhoneProps,
  MockupWindowProps,
  MessageDescriptor,
  MessageParamValue,
  MessageValue,
  PageChildren,
  PresentationContext,
  ResolvedMessage,
  StatusProps,
  TextValue,
} from "@canlang/contracts";
import { appearanceClasses } from "./appearance.js";
import { pickAppearance } from "./internal/appearance-props.js";
import { renderTextValue } from "./components.js";
import { escapeAttr, escapeHtml, safeHref } from "./escape.js";
import {
  canonicalDefaultTag,
  canonicalPreferredTags,
  formatScalar,
  resolveCaption,
  resolvedText,
} from "./messages.js";

function joinClasses(base: string, modifiers: string): string {
  return modifiers === "" ? base : `${base} ${modifiers}`;
}

function pageLocaleOf(context: PresentationContext): string {
  const preferred = canonicalPreferredTags(context.preferredLocales);
  return preferred[0] ?? canonicalDefaultTag(context.appDefaultLocale);
}

function isMessageDescriptor(
  value: MessageDescriptor | MessageParamValue | ResolvedMessage,
): value is MessageDescriptor {
  return typeof (value as MessageDescriptor).source === "string";
}

/**
 * Plain (unescaped, unisolated) text of a TextValue for aria-label sinks.
 * Callers must escape the result for the attribute sink. Primitives use
 * String() (bigint-safe); descriptors resolve captions; {type, value}
 * pairs format as scalars; null/undefined render as empty.
 */
function plainTextOf(value: TextValue, context: PresentationContext): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  const formatted = resolvedText(value);
  if (formatted !== undefined) {
    return formatted.text;
  }
  if (isMessageDescriptor(value)) {
    return resolveCaption(value, context);
  }
  return formatScalar(value as MessageParamValue, {
    locale: pageLocaleOf(context),
    timeZone: "UTC",
    ...(context.currencyScales !== undefined
      ? { currencyScales: context.currencyScales }
      : {}),
  });
}

function captionText(caption: MessageValue, context: PresentationContext): string {
  return resolveCaption(caption, context);
}

/**
 * Readable typed value with its owning caption. The value renders visibly;
 * when a caption is present it prefixes the accessible name as
 * "{caption}: {value}".
 */
export async function badge(props: BadgeProps): Promise<string> {
  const modifiers = appearanceClasses("badge", "badge", pickAppearance(props));
  const visible = renderTextValue(props.value, props.context);
  const label =
    props.caption === undefined
      ? ""
      : ` aria-label="${escapeAttr(`${captionText(props.caption, props.context)}: ${plainTextOf(props.value, props.context)}`)}"`;
  return `<span class="${escapeAttr(joinClasses("badge", modifiers))}"${label}>${visible}</span>`;
}

/**
 * Explicit readable state: a visible dot plus a screen-reader text
 * alternative. The accessible name is the caption when present, else the
 * value text.
 */
export async function status(props: StatusProps): Promise<string> {
  const modifiers = appearanceClasses("status", "status", pickAppearance(props));
  const valueText = plainTextOf(props.value, props.context);
  const label =
    props.caption === undefined ? valueText : captionText(props.caption, props.context);
  const visible = renderTextValue(props.value, props.context);
  return (
    `<span class="${escapeAttr(joinClasses("status", modifiers))}" aria-label="${escapeAttr(label)}">` +
    `<span class="sr-only">${visible}</span></span>`
  );
}

/**
 * Shortcut notation: one kbd element per key, joined with "+" text.
 * Registers no keyboard handler. Throws when `keys` is empty.
 */
export async function kbd(props: KbdProps): Promise<string> {
  if (props.keys.length === 0) {
    throw new Error("kbd needs at least one key");
  }
  const modifiers = appearanceClasses("kbd", "kbd", pickAppearance(props));
  const cls = escapeAttr(joinClasses("kbd", modifiers));
  return props.keys.map((key) => `<kbd class="${cls}">${escapeHtml(key)}</kbd>`).join("+");
}

/**
 * Escaped code display: one upstream `pre[data-prefix]` line per source
 * line (prefix "$"), inside `.mockup-code`. Content is never interpreted.
 */
export async function mockupCode(props: MockupCodeProps): Promise<string> {
  // mockup_code admits no appearance matrix: any runtime appearance key
  // throws via the membership check below.
  appearanceClasses("mockup_code", "mockup-code", pickAppearance(props));
  if (typeof props.code !== "string") {
    throw new TypeError("mockupCode code must be a string");
  }
  const lines = props.code.split(/\r?\n/);
  const rendered = lines
    .map((line) => `<pre data-prefix="$"><code>${escapeHtml(line)}</code></pre>`)
    .join("");
  return `<div class="mockup-code">${rendered}</div>`;
}

/**
 * View-only numeric display in the upstream countdown shape. `value` must
 * be a finite number >= 0 (else RangeError); the integer part renders via
 * the `--value` custom property. Schedules no timers. A caption becomes
 * the accessible name.
 */
export async function countdown(props: CountdownProps): Promise<string> {
  // countdown admits only the base class (variant "solid" is a no-op);
  // any other runtime appearance key throws here.
  appearanceClasses("countdown", "countdown", pickAppearance(props));
  if (typeof props.value !== "number" || !Number.isFinite(props.value) || props.value < 0) {
    throw new RangeError(`countdown value must be a finite number >= 0, got ${String(props.value)}`);
  }
  const label =
    props.caption === undefined
      ? ""
      : ` aria-label="${escapeAttr(captionText(props.caption, props.context))}"`;
  return `<span class="countdown"${label}><span style="--value:${String(Math.floor(props.value))}"></span></span>`;
}

/**
 * Separation with an optional authored caption. Empty when no caption is
 * given (upstream `.divider:not(:empty)` draws the captioned variant).
 */
export async function divider(props: DividerProps): Promise<string> {
  const modifiers = appearanceClasses("divider", "divider", pickAppearance(props));
  const body = props.caption === undefined ? "" : escapeHtml(captionText(props.caption, props.context));
  return `<div class="${escapeAttr(joinClasses("divider", modifiers))}">${body}</div>`;
}

/**
 * Checked-destination link. The caption (else the target) renders as text;
 * hostile targets fall back to "#" via safeHref.
 */
export async function link(props: LinkProps): Promise<string> {
  const modifiers = appearanceClasses("link", "link", pickAppearance(props));
  const href = escapeAttr(safeHref(props.target));
  const text =
    props.caption === undefined
      ? escapeHtml(props.target)
      : escapeHtml(captionText(props.caption, props.context));
  return `<a class="${escapeAttr(joinClasses("link", modifiers))}" href="${href}">${text}</a>`;
}

// ---------------------------------------------------------------------------
// mockup browser/phone/window (C8)
// ---------------------------------------------------------------------------

/** Await trusted pre-rendered children; empty suites fail closed. */
async function renderMockupKids(factory: string, children: PageChildren): Promise<string> {
  const kids = typeof children === "function" ? await children() : children;
  if (kids.length === 0) {
    throw new Error(`${factory} needs a nonempty content suite`);
  }
  return (await Promise.all(kids)).join("");
}

function mockupLabel(caption: MessageValue | undefined, context: PresentationContext): string {
  if (caption === undefined) {
    return "";
  }
  const text = resolveCaption(caption, context);
  if (text === "") {
    throw new Error("mockup caption must not be empty");
  }
  return ` aria-label="${escapeAttr(text)}"`;
}

/**
 * Browser-chrome presentation wrapper: toolbar dots plus a URL bar holding
 * escaped text (never a link or engine). Children are trusted pre-rendered
 * HTML from sibling factories (the card-children precedent).
 */
export async function mockupBrowser(props: MockupBrowserProps): Promise<string> {
  // mockup_browser admits no appearance matrix: any runtime appearance key
  // throws via the membership check below.
  appearanceClasses("mockup_browser", "mockup-browser", pickAppearance(props));
  const body = await renderMockupKids("mockupBrowser", props.children);
  const url =
    props.url === undefined ? "" : escapeHtml(resolveCaption(props.url, props.context));
  return (
    `<div class="mockup-browser"${mockupLabel(props.caption, props.context)}>` +
    `<div class="mockup-browser-toolbar"><div class="input">${url}</div></div>` +
    `<div>${body}</div></div>`
  );
}

/**
 * Phone-chrome presentation wrapper: camera notch plus display slot holding
 * trusted children. No device frame behavior beyond the pinned CSS.
 */
export async function mockupPhone(props: MockupPhoneProps): Promise<string> {
  // mockup_phone admits no appearance matrix: any runtime appearance key
  // throws via the membership check below.
  appearanceClasses("mockup_phone", "mockup-phone", pickAppearance(props));
  const body = await renderMockupKids("mockupPhone", props.children);
  return (
    `<div class="mockup-phone"${mockupLabel(props.caption, props.context)}>` +
    `<div class="mockup-phone-camera"></div>` +
    `<div class="mockup-phone-display">${body}</div></div>`
  );
}

/**
 * Window-chrome presentation wrapper: title dots plus a content slot
 * holding trusted children. No window-manager behavior.
 */
export async function mockupWindow(props: MockupWindowProps): Promise<string> {
  // mockup_window admits no appearance matrix: any runtime appearance key
  // throws via the membership check below.
  appearanceClasses("mockup_window", "mockup-window", pickAppearance(props));
  const body = await renderMockupKids("mockupWindow", props.children);
  return (
    `<div class="mockup-window"${mockupLabel(props.caption, props.context)}>` +
    `<div>${body}</div></div>`
  );
}
