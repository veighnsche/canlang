/**
 * C5 floating/feedback/effect factories: alert, toast, tooltip, indicator,
 * chat_bubble, dropdown, modal, drawer, swap, fab, aura, mask, hover_3d,
 * hover_gallery.
 *
 * Async server-rendered string builders (props -> escaped HTML), following the
 * C3 leaves/media precedent. No h(), no hydration, no client state: every
 * factory resolves captions through resolveCaption, routes appearance through
 * appearanceClasses under the word's exact catalog id (unadmitted tokens
 * throw), escapes every dynamic string for its sink, and fails closed on
 * invalid input (throws, never silent truncation or guessed markup). Slot
 * content arrives as PageChildren: trusted pre-rendered HTML from sibling
 * factories, awaited and passed through verbatim.
 *
 * Activation without JavaScript: modal uses the native <dialog> element opened
 * via the upstream :target pattern (generated opener links to #id, close
 * links back to #); drawer and swap use the upstream checkbox-toggle pattern
 * (drawer-toggle / .swap input); dropdown and fab use the upstream
 * focus-within pattern (tabindex trigger, CSS reveals content). Keyboard
 * users reach every trigger by Tab; the drawer checkbox itself is the native
 * keyboard control, matching the shell's documented behavior.
 *
 * Upstream evidence (daisyUI 5.7.47, pinned object.js selectors):
 * alert tones info/success/warning/error + outline/soft + horizontal/vertical;
 * toast placement only (no tone scale); tooltip tones without neutral;
 * indicator-item positions (not admitted: plain item only); chat-bubble
 * tones, chat-start/end alignment, chat-image/header/footer slots;
 * dropdown-content focus pattern; dialog.modal + modal-box + modal-action;
 * drawer-toggle/drawer-content/drawer-side/drawer-overlay/drawer-button;
 * swap-on/swap-off checkbox slots; fab focus-within reveal (no fab-close: a
 * close control cannot act without JS, so defocus closes); aura sizes;
 * mask shapes (not admitted: bare .mask only); hover-3d layered wrapper;
 * hover-gallery 1..10 children.
 */

import type {
  AlertProps,
  AuraProps,
  ChatBubbleProps,
  DrawerProps,
  DropdownProps,
  FabProps,
  Hover3dProps,
  HoverGalleryProps,
  IndicatorProps,
  MaskProps,
  MessageValue,
  ModalProps,
  PageChildren,
  PresentationContext,
  SwapProps,
  TextValue,
  ToastProps,
  TooltipProps,
} from "@canlang/contracts";
import { appearanceClasses } from "./appearance.js";
import { pickAppearance } from "./internal/appearance-props.js";
import { renderTextValue } from "./components.js";
import { escapeAttr, escapeHtml, safeHref } from "./escape.js";
import { assertRegionId } from "./htmx.js";
import { message, resolveCaption } from "./messages.js";

/** Shared overlay wording (ui.overlays.*): en source + nl variant. */
const CHROME = {
  close: message("Close", { nl: "Sluiten" }),
  fabLabel: message("Quick actions", { nl: "Snelle acties" }),
} as const;

/** Local activation identity shape for modal/drawer ids (fragment-safe). */
const ACTIVATION_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Interactive descendants forbidden inside hover_3d (upstream restriction). */
const INTERACTIVE_TAG_RE = /<(a|button|input|select|textarea|label|details|dialog|video|audio|iframe|embed|object)[\s>/]/i;

/** Pinned upstream hover_gallery image bounds; excess is an error, never cut. */
const HOVER_GALLERY_MIN_IMAGES = 1;
const HOVER_GALLERY_MAX_IMAGES = 10;

function joinClasses(base: string, modifiers: string): string {
  return modifiers === "" ? base : `${base} ${modifiers}`;
}

/** Await trusted slot HTML; empty suites fail closed. */
async function requireChildren(slot: string, children: PageChildren): Promise<string> {
  const list = typeof children === "function" ? await children() : children;
  if (list.length === 0) {
    throw new Error(`${slot} needs at least one child`);
  }
  const body = (await Promise.all(list)).join("");
  if (body === "") {
    throw new Error(`${slot} must not render empty`);
  }
  return body;
}

/**
 * alert/toast payload rule: exactly one of a readable value or a nonempty
 * suite. Both or neither is a contract error; empty values fail closed.
 */
async function valueOrChildren(
  word: string,
  context: PresentationContext,
  value: TextValue | undefined,
  children: PageChildren | undefined,
): Promise<string> {
  const hasValue = value !== undefined && value !== null;
  const hasChildren = children !== undefined;
  if (hasValue && hasChildren) {
    throw new Error(`${word} takes a value or children, not both`);
  }
  if (!hasValue && !hasChildren) {
    throw new Error(`${word} needs a value or children`);
  }
  if (hasChildren) {
    return requireChildren(word, children as PageChildren);
  }
  if (typeof value === "string" && value === "") {
    throw new Error(`${word} value must not be empty`);
  }
  return renderTextValue(value as TextValue, context);
}

/** Stable hx swap-region identity: validated id plus region marker attrs. */
function regionAttrs(regionId: string | undefined): string {
  if (regionId === undefined) {
    return "";
  }
  assertRegionId(regionId);
  const id = escapeAttr(regionId);
  return ` id="${id}" data-region="${id}" hx-swap="outerMorph"`;
}

function assertActivationId(word: string, id: string): void {
  // Explicit string check first: RE.test(undefined) coerces to "undefined",
  // which matches, so a missing id would slip past the pattern alone.
  if (typeof id !== "string" || !ACTIVATION_ID_RE.test(id)) {
    throw new Error(
      `${word} id ${JSON.stringify(id)} must match /^[A-Za-z][A-Za-z0-9_-]*$/`,
    );
  }
}

/** Nonempty resolved caption for components whose profile requires one. */
function requireCaption(word: string, caption: MessageValue, context: PresentationContext): string {
  const text = resolveCaption(caption, context);
  if (text === "") {
    throw new Error(`${word} caption must not be empty`);
  }
  return text;
}

/**
 * `alert`: readable notice with role=alert. Optional regionId pins a stable
 * hx swap region (can-region hook plus id/data-region/hx-swap contract).
 */
export async function alert(props: AlertProps): Promise<string> {
  const modifiers = appearanceClasses("alert", "alert", pickAppearance(props));
  const body = await valueOrChildren("alert", props.context, props.value, props.children);
  const region = regionAttrs(props.regionId);
  const hooked =
    props.regionId === undefined ? joinClasses("alert", modifiers) : `${joinClasses("alert", modifiers)} can-region`;
  return `<div class="${escapeAttr(hooked)}" role="alert"${region}>${body}</div>`;
}

/**
 * `toast`: notice container (role=status) plus one alert message. The message
 * is a value leaf or a readable suite, mirroring alert's payload rule.
 */
export async function toast(props: ToastProps): Promise<string> {
  // toast admits no appearance matrix: any runtime appearance key throws.
  appearanceClasses("toast", "toast", pickAppearance(props));
  const body = await valueOrChildren("toast", props.context, props.message, props.children);
  const region = regionAttrs(props.regionId);
  const cls = props.regionId === undefined ? "toast" : "toast can-region";
  return (
    `<div class="${cls}" role="status"${region}>` +
    `<div class="alert">${body}</div></div>`
  );
}

/**
 * `tooltip`: required caption in data-tip plus an aria-label alternative and
 * a focusable wrapper so keyboard users reach the annotation context.
 */
export async function tooltip(props: TooltipProps): Promise<string> {
  const modifiers = appearanceClasses("tooltip", "tooltip", pickAppearance(props));
  const tip = requireCaption("tooltip", props.caption, props.context);
  const body = await requireChildren("tooltip content", props.content);
  return (
    `<span class="${escapeAttr(joinClasses("tooltip", modifiers))}" ` +
    `data-tip="${escapeAttr(tip)}" tabindex="0" aria-label="${escapeAttr(tip)}">${body}</span>`
  );
}

/**
 * `indicator`: explicit content with an upstream indicator-item marker
 * rendered first, per the pinned indicator pattern.
 */
export async function indicator(props: IndicatorProps): Promise<string> {
  appearanceClasses("indicator", "indicator", pickAppearance(props));
  const content = await requireChildren("indicator content", props.content);
  const marker = await requireChildren("indicator indicator", props.indicator);
  return `<span class="indicator"><span class="indicator-item">${marker}</span>${content}</span>`;
}

/**
 * `chat_bubble`: explicit message with start/end alignment. Tone applies to
 * the bubble; avatar/header/footer slots wrap in their upstream containers.
 * Time renders inside header/footer suites as authored <time> markup.
 */
export async function chatBubble(props: ChatBubbleProps): Promise<string> {
  const modifiers = appearanceClasses("chat_bubble", "chat-bubble", pickAppearance(props));
  const side = props.side ?? "start";
  if (side !== "start" && side !== "end") {
    throw new RangeError(`chat_bubble side must be "start" or "end", got ${JSON.stringify(side)}`);
  }
  const content = await requireChildren("chat_bubble content", props.content);
  const avatar =
    props.avatar === undefined
      ? ""
      : `<div class="chat-image">${await requireChildren("chat_bubble avatar", props.avatar)}</div>`;
  const header =
    props.header === undefined
      ? ""
      : `<div class="chat-header">${await requireChildren("chat_bubble header", props.header)}</div>`;
  const footer =
    props.footer === undefined
      ? ""
      : `<div class="chat-footer">${await requireChildren("chat_bubble footer", props.footer)}</div>`;
  const bubble = escapeAttr(joinClasses("chat-bubble", modifiers));
  const frame = side === "start" ? "chat chat-start" : "chat chat-end";
  return `<div class="${frame}">${avatar}${header}<div class="${bubble}">${content}</div>${footer}</div>`;
}

/**
 * `dropdown`: trigger plus content under the shared focus contract. Both the
 * trigger (role=button, focusable) and the content wrapper are tabbable, so
 * the upstream :focus-within CSS opens the menu for keyboard users too.
 */
export async function dropdown(props: DropdownProps): Promise<string> {
  appearanceClasses("dropdown", "dropdown", pickAppearance(props));
  const trigger = await requireChildren("dropdown trigger", props.trigger);
  const content = await requireChildren("dropdown content", props.content);
  return (
    `<div class="dropdown">` +
    `<div tabindex="0" role="button" aria-haspopup="true">${trigger}</div>` +
    `<div tabindex="0" class="dropdown-content bg-base-100 rounded-box w-64 p-2 shadow">${content}</div>` +
    `</div>`
  );
}

/**
 * `modal`: native dialog with captioned box and optional action slot. The
 * dialog opens through the upstream :target pattern: the generated opener
 * links to #id (hence trigger-or-id is required) and the close control
 * links back to #. A provided trigger carries its own activation binding:
 * without JS only an `a[href="#id"]` opener reaches the dialog, so authors
 * must pass that shape (a bare `<button>` trigger is inert).
 */
export async function modal(props: ModalProps): Promise<string> {
  const modifiers = appearanceClasses("modal", "modal", pickAppearance(props));
  const caption = requireCaption("modal", props.caption, props.context);
  if (props.id !== undefined) {
    assertActivationId("modal", props.id);
  }
  if (props.trigger === undefined && props.id === undefined) {
    throw new Error("modal needs a trigger slot or an id for its generated opener");
  }
  const content = await requireChildren("modal content", props.content);
  const trigger =
    props.trigger === undefined
      ? `<a class="btn" href="#${escapeAttr(props.id as string)}">${escapeHtml(caption)}</a>`
      : await requireChildren("modal trigger", props.trigger);
  const actions =
    props.actions === undefined
      ? ""
      : `<div class="modal-action">${await requireChildren("modal actions", props.actions)}</div>`;
  const closeLabel = escapeAttr(resolveCaption(CHROME.close, props.context));
  const idAttr = props.id === undefined ? "" : ` id="${escapeAttr(props.id)}"`;
  const naming =
    props.id === undefined
      ? ` aria-label="${escapeAttr(caption)}"`
      : ` aria-labelledby="${escapeAttr(`${props.id}-title`)}"`;
  const titleId = props.id === undefined ? "" : ` id="${escapeAttr(`${props.id}-title`)}"`;
  return (
    `${trigger}` +
    `<dialog class="${escapeAttr(joinClasses("modal", modifiers))}"${idAttr}${naming}>` +
    `<div class="modal-box">` +
    `<a href="#" class="btn btn-sm btn-circle absolute right-2 top-2" aria-label="${closeLabel}">✕</a>` +
    `<h3${titleId} class="text-lg font-bold">${escapeHtml(caption)}</h3>` +
    `${content}${actions}</div></dialog>`
  );
}

/**
 * `drawer`: checkbox-toggled side panel holding the scoped content, with the
 * trigger (or a generated drawer-button opener) in the content area. The id
 * is required: the JS-free toggle/label contract cannot work without it. A
 * provided trigger carries its own binding: without JS only a
 * `label[for="id"]` toggles the panel, so authors must pass that shape.
 */
export async function drawer(props: DrawerProps): Promise<string> {
  const modifiers = appearanceClasses("drawer", "drawer", pickAppearance(props));
  const caption = requireCaption("drawer", props.caption, props.context);
  assertActivationId("drawer", props.id);
  const content = await requireChildren("drawer content", props.content);
  const id = escapeAttr(props.id);
  const trigger =
    props.trigger === undefined
      ? `<label for="${id}" class="btn drawer-button">${escapeHtml(caption)}</label>`
      : await requireChildren("drawer trigger", props.trigger);
  const actions =
    props.actions === undefined
      ? ""
      : `<footer>${await requireChildren("drawer actions", props.actions)}</footer>`;
  const closeLabel = escapeAttr(resolveCaption(CHROME.close, props.context));
  return (
    `<div class="${escapeAttr(joinClasses("drawer", modifiers))}">` +
    `<input id="${id}" type="checkbox" class="drawer-toggle">` +
    `<div class="drawer-content">${trigger}</div>` +
    `<div class="drawer-side">` +
    `<label for="${id}" class="drawer-overlay" aria-label="${closeLabel}"></label>` +
    `<aside class="w-80 min-h-full bg-base-200 flex flex-col" aria-labelledby="${id}-title">` +
    `<h2 id="${id}-title" class="px-4 py-3 text-lg font-bold">${escapeHtml(caption)}</h2>` +
    `<div class="flex-1 overflow-y-auto">${content}</div>${actions}` +
    `</aside></div></div>`
  );
}

/**
 * `swap`: label-wrapped checkbox selecting the on/off slots. The checkbox
 * owns transient view state (checked reflects `active`); a bound preference
 * reuses the same checked contract. Label click and keyboard toggle it.
 */
export async function swap(props: SwapProps): Promise<string> {
  appearanceClasses("swap", "swap", pickAppearance(props));
  const on = await requireChildren("swap on", props.on);
  const off = await requireChildren("swap off", props.off);
  const checked = props.active === true ? " checked" : "";
  const label =
    props.label === undefined
      ? ""
      : ` aria-label="${escapeAttr(requireCaption("swap", props.label, props.context))}"`;
  return (
    `<label class="swap"><input type="checkbox"${checked}${label}>` +
    `<div class="swap-on">${on}</div><div class="swap-off">${off}</div></label>`
  );
}

/**
 * `fab`: focusable main trigger plus action items revealed by the upstream
 * :focus-within CSS. Items must be sibling controls (buttons/links); the
 * group carries a localized accessible name defaulting to "Quick actions".
 */
export async function fab(props: FabProps): Promise<string> {
  appearanceClasses("fab", "fab", pickAppearance(props));
  const label =
    props.label === undefined
      ? resolveCaption(CHROME.fabLabel, props.context)
      : resolveCaption(props.label, props.context);
  const main = await requireChildren("fab main", props.main);
  const actions = await requireChildren("fab actions", props.actions);
  return (
    `<div class="fab" role="group" aria-label="${escapeAttr(label)}">` +
    `<div tabindex="0" role="button">${main}</div>` +
    `${actions}</div>`
  );
}

/**
 * `aura`: decoration around existing content. Only sizes are admitted;
 * upstream effect names (gold/silver/holo) are not tone tokens.
 */
export async function aura(props: AuraProps): Promise<string> {
  const modifiers = appearanceClasses("aura", "aura", pickAppearance(props));
  const body = await requireChildren("aura", props.content);
  return `<div class="${escapeAttr(joinClasses("aura", modifiers))}">${body}</div>`;
}

/**
 * `mask`: visual shape around existing content. Upstream shapes are not
 * admitted tokens, so the factory emits the bare .mask wrapper.
 */
export async function mask(props: MaskProps): Promise<string> {
  appearanceClasses("mask", "mask", pickAppearance(props));
  const body = await requireChildren("mask", props.content);
  return `<div class="mask">${body}</div>`;
}

/**
 * `hover_3d`: decorative wrapper enforcing the upstream restriction: any
 * interactive descendant tag in the rendered suite fails the render.
 */
export async function hover3d(props: Hover3dProps): Promise<string> {
  appearanceClasses("hover_3d", "hover-3d", pickAppearance(props));
  const body = await requireChildren("hover_3d", props.content);
  const hit = INTERACTIVE_TAG_RE.exec(body);
  if (hit !== null) {
    throw new Error(`hover_3d forbids interactive descendants, found <${hit[1] as string}>`);
  }
  return `<div class="hover-3d">${body}</div>`;
}

/**
 * `hover_gallery`: 1..10 images (pinned upstream bound; excess throws, never
 * truncates). Every image carries required alt text; items are focusable so
 * keyboard and touch users reach each image with its alternative.
 */
export async function hoverGallery(props: HoverGalleryProps): Promise<string> {
  appearanceClasses("hover_gallery", "hover-gallery", pickAppearance(props));
  if (
    props.images.length < HOVER_GALLERY_MIN_IMAGES ||
    props.images.length > HOVER_GALLERY_MAX_IMAGES
  ) {
    throw new RangeError(
      `hover_gallery needs ${HOVER_GALLERY_MIN_IMAGES}..${HOVER_GALLERY_MAX_IMAGES} images, got ${props.images.length}`,
    );
  }
  const items = props.images
    .map((image, index) => {
      if (typeof image.src !== "string" || image.src === "" || safeHref(image.src) !== image.src) {
        throw new TypeError(`hover_gallery image ${index}: src must be a safe non-empty URL`);
      }
      const alt = resolveCaption(image.alt, props.context);
      return `<li tabindex="0"><img src="${escapeAttr(image.src)}" alt="${escapeAttr(alt)}"></li>`;
    })
    .join("");
  return `<ul class="hover-gallery">${items}</ul>`;
}
