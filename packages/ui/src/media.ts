/**
 * C3 media leaves: avatar, progress, radial_progress, text_rotate.
 *
 * Async factories (props -> escaped HTML string). Every dynamic string is
 * resolved through message captions and escaped for its sink; image URLs pass
 * through safeHref and fail closed to the placeholder (never an <img> with a
 * hostile src). Appearance flows through appearanceClasses against the
 * word's admitted catalog matrix: unadmitted tokens throw.
 *
 * Upstream evidence (daisyUI 5.7.47, pinned):
 * - avatar / avatar-placeholder: components/avatar.css. The sizing/shape
 *   utilities w-12 / rounded-full are Tailwind, not daisyUI: they are absent
 *   from the themes.test.ts TAILWIND_UTILS allowlist and need coordinator
 *   reconciliation (genuinely new utilities, not typos).
 * - progress-{tone} for all eight tones: components/progress.css.
 * - radial-progress base class: components/radialprogress.css (--value 0..100
 *   scale, default --size 5rem; this factory pins --size:3rem).
 * - text-rotate item pattern: components/textrotate.css selects
 *   `.text-rotate > *` (single grid wrapper whose children are counted via
 *   :has(> *:nth-child(N))) and animates 2..6 items; reduced-motion behavior
 *   (steps() fallback under prefers-reduced-motion: reduce) is entirely
 *   upstream CSS, so this factory emits no motion-related markup or JS.
 */

import type {
  AppearanceOrientation,
  AppearanceSize,
  AppearanceTone,
  AppearanceVariant,
  AvatarProps,
  MessageValue,
  PresentationContext,
  ProgressProps,
  RadialProgressProps,
  TextRotateProps,
} from "../../contracts/src/presentation.js";
import { appearanceClasses, type AppearanceOpts } from "./appearance.js";
import { escapeAttr, escapeHtml, safeHref } from "./escape.js";
import { message, resolveCaption } from "./messages.js";

/** Shared captions (ui.media.*): en source + nl variant. */
const UNAVAILABLE_IMAGE = message("Image unavailable", { nl: "Afbeelding niet beschikbaar" });
const INVALID_PROGRESS = message("Invalid progress value", { nl: "Ongeldige voortgangswaarde" });
const PROGRESS_LABEL = message("Progress", { nl: "Voortgang" });

/** Shared avatar placeholder glyph when no explicit fallback is supplied. */
const PLACEHOLDER_GLYPH = "?";

/** Pinned upstream text_rotate item bounds; excess is a diagnostic, never truncated. */
const TEXT_ROTATE_MIN_ITEMS = 1;
const TEXT_ROTATE_MAX_ITEMS = 6;

function captionOf(context: PresentationContext, value: MessageValue): string {
  return resolveCaption(value, context);
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

/**
 * `avatar`: authorized image or explicit safe fallback. An <img> renders only
 * when image is a non-empty string whose safeHref is not the "#" fallback;
 * null/absent/empty/hostile images render the placeholder with the explicit
 * fallback text or the shared "?" glyph. The accessible name (img alt) is
 * caption ?? fallback ?? the shared unavailable-image label; caption/fallback
 * are escaped plain text, never HTML or URLs.
 */
export async function avatar(props: AvatarProps): Promise<string> {
  const extra = appearanceClasses("avatar", "avatar", pickAppearance(props));
  const outer = extra === "" ? "avatar" : `avatar ${extra}`;
  const name =
    props.caption !== undefined
      ? captionOf(props.context, props.caption)
      : props.fallback !== undefined
        ? captionOf(props.context, props.fallback)
        : captionOf(props.context, UNAVAILABLE_IMAGE);
  const image = props.image;
  const useImage = typeof image === "string" && image !== "" && safeHref(image) !== "#";
  if (useImage) {
    return (
      `<div class="${escapeAttr(outer)}"><div class="w-12 rounded-full">` +
      `<img src="${escapeAttr(safeHref(image as string))}" alt="${escapeAttr(name)}">` +
      `</div></div>`
    );
  }
  const text =
    props.fallback !== undefined ? captionOf(props.context, props.fallback) : PLACEHOLDER_GLYPH;
  const placeholderOuter = extra === "" ? "avatar avatar-placeholder" : `${outer} avatar-placeholder`;
  return (
    `<div class="${escapeAttr(placeholderOuter)}" aria-label="${escapeAttr(name)}"><div class="w-12 rounded-full">` +
    `<span>${escapeHtml(text)}</span>` +
    `</div></div>`
  );
}

function assertValidMax(max: number): void {
  if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) {
    throw new RangeError(`progress max must be a finite number > 0, got ${String(max)}`);
  }
}

function isValidValue(value: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
}

/**
 * Explicit invalid presentation for out-of-range/NaN values: a role=alert
 * error notice, never a clamped bar. The max check (throw) runs before the
 * value check (alert), so a doubly-invalid call throws.
 */
function invalidProgress(context: PresentationContext, caption: MessageValue | undefined): string {
  const text =
    caption !== undefined ? captionOf(context, caption) : captionOf(context, INVALID_PROGRESS);
  return `<p role="alert" class="alert alert-error">${escapeHtml(text)}</p>`;
}

/**
 * Percent text shared by progress/radial_progress. Exact String(value/max*100)
 * with no rounding: common halves render cleanly (50/100 -> "50") while
 * repeating fractions keep full float precision (1/3 -> "33.333333333333336").
 */
function percentText(value: number, max: number): string {
  return String((value / max) * 100);
}

/**
 * `progress`: readable numeric with a finite positive max. Value/max render
 * via exact decimal text (String(), no rounding); the element carries a
 * percent text fallback for no-CSS clients.
 */
export async function progress(props: ProgressProps): Promise<string> {
  assertValidMax(props.max);
  if (!isValidValue(props.value, props.max)) {
    return invalidProgress(props.context, props.caption);
  }
  const extra = appearanceClasses("progress", "progress", pickAppearance(props));
  const classes = extra === "" ? "progress" : `progress ${extra}`;
  const percent = percentText(props.value, props.max);
  return (
    `<progress class="${escapeAttr(classes)}" value="${escapeAttr(String(props.value))}" ` +
    `max="${escapeAttr(String(props.max))}">${escapeHtml(percent)}%</progress>`
  );
}

/**
 * `radial_progress`: same validation/invalid rules as progress in a circular
 * presentation. The caption feeds aria-label only (defaulting to the shared
 * "Progress" label); visible text is the exact percent.
 */
export async function radialProgress(props: RadialProgressProps): Promise<string> {
  assertValidMax(props.max);
  if (!isValidValue(props.value, props.max)) {
    return invalidProgress(props.context, props.caption);
  }
  const extra = appearanceClasses("radial_progress", "radial-progress", pickAppearance(props));
  const classes = extra === "" ? "radial-progress" : `radial-progress ${extra}`;
  const percent = percentText(props.value, props.max);
  const label =
    props.caption !== undefined
      ? captionOf(props.context, props.caption)
      : captionOf(props.context, PROGRESS_LABEL);
  return (
    `<div class="${escapeAttr(classes)}" style="--value:${escapeAttr(percent)}; --size:3rem;" ` +
    `role="progressbar" aria-valuenow="${escapeAttr(String(props.value))}" aria-valuemin="0" ` +
    `aria-valuemax="${escapeAttr(String(props.max))}" aria-label="${escapeAttr(label)}">` +
    `${escapeHtml(percent)}%</div>`
  );
}

/**
 * `text_rotate`: authored readable sequence of 1..6 resolved items (pinned
 * upstream limits; 0 or 7+ throw RangeError). Markup follows the upstream
 * wrapper pattern: .text-rotate > single grid child > one span per item.
 * Items are resolved captions, escaped plain text.
 */
export async function textRotate(props: TextRotateProps): Promise<string> {
  if (props.items.length < TEXT_ROTATE_MIN_ITEMS || props.items.length > TEXT_ROTATE_MAX_ITEMS) {
    throw new RangeError(
      `text_rotate needs ${TEXT_ROTATE_MIN_ITEMS}..${TEXT_ROTATE_MAX_ITEMS} items, got ${props.items.length}`,
    );
  }
  const extra = appearanceClasses("text_rotate", "text-rotate", pickAppearance(props));
  const classes = extra === "" ? "text-rotate" : `text-rotate ${extra}`;
  const items = props.items
    .map((item) => `<span>${escapeHtml(captionOf(props.context, item))}</span>`)
    .join("");
  return `<span class="${escapeAttr(classes)}"><span>${items}</span></span>`;
}
