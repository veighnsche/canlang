/**
 * Browser client entry (FP.BROWSER): focus/keyboard/unsaved-form
 * behavior, poll-region arming, and obsolete-action guards over
 * server-rendered catalog markup.
 *
 * Bootstrap binds BEHAVIOR to markup; it never invents routes, URLs,
 * or components. Per-component binders register by catalog component
 * id (`registerBinder`) — this slice seeds the core binders (poll
 * regions, guarded forms, once-only actions); the planned
 * forms/drawers/navigation/settings slices register their own ids,
 * and unknown ids are ignored so markup never breaks on a binder
 * that has not landed. Full 68-word binding coverage completes with
 * those slices; the build records the catalog version it bound
 * against (see `ui/scripts/build-browser.mjs`).
 *
 * Generated operation forms require this client to project their bracketed
 * controls into the canonical JSON envelope; native no-JS submission is
 * not qualified. Other behaviors progressively enhance markup, and
 * no-htmx pages simply skip swap hooks:
 *
 * - Poll regions: `[data-can-poll]` elements arm one `PollRegion`
 *   each (`data-can-poll-url`, `data-can-poll-interval`,
 *   `data-can-poll-context`); regions re-arm after htmx swaps and
 *   terminate on hidden/context/logout/region-gone per polling.ts.
 * - Unsaved forms: `form[data-can-guard]` tracks dirtiness; a dirty
 *   form arms `beforeunload`, and submit clears it. Navigation away
 *   with unsaved input warns; no other form is affected.
 * - Generated forms: `form[data-can-generated-form]` binds the exact
 *   prepared operation metadata to the existing submit client. Result
 *   denials render safe text in that form's feedback outlet; its edited
 *   controls stay in place. One pending submission owns its activated
 *   control and abort signal through body reading; disposal aborts the
 *   request and releases that control. Hooks observe current outcomes.
 * - Preferences: canonical native Settings POSTs retain CSRF/version fields.
 *   Their authorized full response refreshes main content and accepted Settings
 *   values, preserving other drafts and the modal's current open state.
 * - Explicit once controls: `[data-can-once]` requires an owning transport
 *   that emits `can:settled` on the same control. The binder alone is not
 *   a qualified submission workflow; current generated forms use their
 *   own pending guard and transport settlement.
 * - Generated views: `[data-can-view]` roots invoke their view's
 *   registered saved `mount` once with the server-embedded presentation;
 *   replaced roots release the returned cleanup through the binder
 *   unbind and the morph removal hook. Roots without a registered mount
 *   stay inert markup.
 * - Focus: after an htmx swap into `#can-main`, focus moves to the
 *   swapped heading (or `#can-main` itself); opening a `:target`
 *   dialog focuses its box. Focus never moves on ordinary loads.
 * - Keyboard: Escape closes open `details` dropdowns; native dialog
 *   Escape stays native. No other keys are bound.
 * - URL/history: hx-push-url owns history (htmx-side); bootstrap
 *   exposes the context key (`data-can-context` on `<body>`)
 *   poll regions terminate against.
 *
 * DOM access stays behind structural interfaces (satisfied by the
 * real DOM and by fakes): `startBrowserClient` takes the document,
 * window, and fetch explicitly and returns a stop handle.
 */
import { bindGallery } from "./gallery.js";
import type { ImageFetch, ImageFetchInit } from "./gallery.js";
import { PollRegion, submitFetchPollFetch } from "./polling.js";
import type { VisibilityLike } from "./polling.js";
import { GeneratedSubmitError, submitGeneratedForm, submitDeleteForm } from "../client.js";
import type { DomControlLike, GeneratedSubmitResult, SubmitFetch, SubmitFetchInit } from "../client.js";
import type { DerivedOperationInputs, DerivedWritableInput, FormMode } from "@canlang/contracts";
import type { GeneratedViewMount, GeneratedViewPresentation, RowView } from "@canlang/contracts";
import { CSRF_FIELD, SOURCE_FORM_BINDING_FIELD, GENERATED_REF_VERSION_SUFFIX, GENERATED_VIEW_ATTR } from "@canlang/contracts";
import { projectGeneratedInputs, GENERATED_NULL_SUFFIX } from "../forms.js";

/** Minimal structural document (satisfied by DOM Document and fakes). */
export interface DocumentLike {
  readonly visibilityState: string;
  readonly body: ElementLike | null;
  readonly activeElement: ElementLike | null;
  querySelectorAll(selectors: string): Iterable<ElementLike>;
  getElementById(id: string): ElementLike | null;
  createElement?(tag: string): unknown;
}

/** Minimal structural element (satisfied by DOM Element and fakes). */
export interface ElementLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  addEventListener(type: string, listener: (event: EventLike) => void): void;
  removeEventListener(type: string, listener: (event: EventLike) => void): void;
  focus(): void;
  readonly tagName: string;
  readonly isConnected: boolean;
  querySelector?(selectors: string): ElementLike | null;
  querySelectorAll?(selectors: string): Iterable<ElementLike>;
}

/** Minimal structural event (satisfied by DOM Event and fakes). */
export interface EventLike {
  readonly target: ElementLike | null;
  readonly type: string;
  readonly persisted?: boolean;
  readonly submitter?: ElementLike | null;
  preventDefault(): void;
  stopPropagation?(): void;
}

/** Native FormData owns successful controls, including the activated submitter. */
interface FormDataConstructor {
  new (form: ElementLike, submitter?: ElementLike | null): Iterable<readonly [string, unknown]>;
}

/** Minimal structural window (satisfied by DOM Window and fakes). */
export interface WindowLike {
  readonly innerWidth?: number;
  readonly innerHeight?: number;
  readonly document: DocumentLike;
  readonly location: { readonly hash: string; readonly pathname?: string; readonly search?: string; readonly href?: string };
  addEventListener(type: string, listener: (event: EventLike) => void): void;
  removeEventListener(type: string, listener: (event: EventLike) => void): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  readonly FormData?: FormDataConstructor;
}

/** Client internals shared with binders (fetch, window, poll delivery). */
export interface ClientInternals {
  readonly fetchImpl: SubmitFetch;
  readonly imageFetch?: ImageFetch;
  readonly windowRef: WindowLike;
  readonly deliver?: BrowserClientOptions["deliverPollResponse"];
  readonly document: DocumentLike;
  readonly visibility: VisibilityLike;
  readonly onGeneratedFormResult?: (form: ElementLike, result: GeneratedSubmitResult, automatic?: boolean) => void;
  readonly onGeneratedFormError?: BrowserClientOptions["onGeneratedFormError"];
  /** Invalidate a pending default page read before a newer mutation starts. */
  readonly onGeneratedFormStart?: () => void;
  /** One active repeat owner per page, released on supersession/context loss. */
  readonly claimRefresh?: (stop: () => void) => void;
}

/** Per-component binder: bind behavior under `root`, return an unbind. */
export type ComponentBinder = (
  root: ElementLike,
  client: BrowserClient,
  internals: ClientInternals,
) => () => void;

const BINDERS = new Map<string, ComponentBinder>();

/**
 * Register a per-component binder by catalog component id. Later
 * slices (forms/drawers/navigation/settings) register here; core
 * binders below are seeded at module load. Re-registering an id
 * replaces it (last writer wins at registration time, never at bind
 * time — binds snapshot the registry per scan).
 */
export function registerBinder(id: string, binder: ComponentBinder): void {
  BINDERS.set(id, binder);
}

/** Catalog ids with a registered client binder. */
export function registeredBinderIds(): ReadonlyArray<string> {
  return [...BINDERS.keys()];
}

/**
 * BGI-09 generated-view mount joins. Unit browser bundles register their
 * saved `mount` by view name; the `generated-view` binder invokes it once
 * per instance root with the server-embedded presentation and tracks the
 * returned cleanup. Replaced roots (morph removal, trims, htmx swaps)
 * release through the binder unbind. In-place morphs release and rebind
 * after canonical markup changes, restoring the mount's DOM enhancements.
 * Mount state is keyed by use id and every release is idempotent,
 * so the morph hook and the rescan sweep never double-run cleanup.
 */

/** Saved mounts by view name, registered by unit browser bundles. */
const GENERATED_VIEW_MOUNTS = new Map<string, GeneratedViewMount>();
/** Live instance cleanups by use id. */
const generatedViewCleanups = new Map<string, () => void>();
const generatedViewRebinds = new WeakSet<object>();
/** Callable acquired by each root; late registration rebinds only that view. */
const generatedViewMountBindings = new WeakMap<object, GeneratedViewMount | undefined>();

/** Register a unit browser bundle's saved `mount` for one view name. */
export function registerGeneratedViewMount(view: string, mount: GeneratedViewMount): void {
  GENERATED_VIEW_MOUNTS.set(view, mount);
}

/** Run and forget one instance's cleanup; unknown ids are a no-op. */
export function releaseGeneratedViewMount(useId: string): void {
  const cleanup = generatedViewCleanups.get(useId);
  if (cleanup === undefined) {
    return;
  }
  generatedViewCleanups.delete(useId);
  cleanup();
}

/** Parse and admit one root's embedded mount presentation. */
function generatedViewPresentationOf(root: ElementLike): GeneratedViewPresentation {
  const useId = root.getAttribute(GENERATED_VIEW_ATTR) ?? "";
  const raw = root.getAttribute("data-can-view-presentation");
  if (raw === null || raw === "") {
    throw new Error(`generated view ${JSON.stringify(useId)}: missing mount presentation`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`generated view ${JSON.stringify(useId)}: invalid mount presentation`);
  }
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>)["view"] !== "string" ||
    (parsed as Record<string, unknown>)["useId"] !== useId
  ) {
    throw new Error(`generated view ${JSON.stringify(useId)}: invalid mount presentation`);
  }
  const row = (parsed as Record<string, unknown>)["row"] as RowView | null | undefined;
  if (typeof row !== "object" || row === null || typeof row.id !== "string" ||
      typeof row.fields !== "object" || row.fields === null) {
    throw new Error(`generated view ${JSON.stringify(useId)}: invalid mount row`);
  }
  return parsed as GeneratedViewPresentation;
}

function bindGeneratedView(root: ElementLike): () => void {
  const useId = root.getAttribute(GENERATED_VIEW_ATTR) ?? "";
  const presentation = generatedViewPresentationOf(root);
  // A replaced root's cleanup never survives onto the new root: release
  // by use id before mounting, and unbind only the cleanup this bind
  // installed (a newer bind for the same id wins).
  releaseGeneratedViewMount(useId);
  generatedViewRebinds.delete(root);
  const mount = GENERATED_VIEW_MOUNTS.get(presentation.view);
  const cleanup = mount === undefined ? undefined : mount(root, presentation);
  generatedViewMountBindings.set(root, mount);
  if (typeof cleanup === "function") {
    generatedViewCleanups.set(useId, cleanup);
  }
  return () => {
    if (generatedViewCleanups.get(useId) === cleanup) {
      releaseGeneratedViewMount(useId);
    }
  };
}

/** Release mounts for a removed subtree: the root itself plus descendants. */
function releaseMountsIn(node: DomNode): void {
  closeManagedDialogsIn(node);
  const direct = node.nodeType === 1 ? node.getAttribute?.(GENERATED_VIEW_ATTR) : null;
  if (direct !== null && direct !== undefined && direct !== "") {
    releaseGeneratedViewMount(direct);
  }
  for (const child of node.querySelectorAll?.(`[${GENERATED_VIEW_ATTR}]`) ?? []) {
    const useId = child.getAttribute?.(GENERATED_VIEW_ATTR);
    if (useId !== null && useId !== undefined && useId !== "") {
      releaseGeneratedViewMount(useId);
    }
  }
}

export interface BrowserClientOptions {
  readonly window: WindowLike;
  readonly fetchImpl: SubmitFetch;
  readonly imageFetch?: ImageFetch;
  /** Visibility defaults to the document; native cache suspension supplies an adapter. */
  readonly visibility?: VisibilityLike;
  /**
   * htmx swap hook when htmx is present: called with a rescan
   * callback to invoke after every swap into `#can-main`. Absent
   * without htmx (regions arm once at start).
   */
  readonly onHtmxSwap?: (rescan: () => void) => () => void;
  /**
   * Optional delivery adapter. The default validates the partial region
   * and morphs its DOM, preserving edited/focused forms. Returning false
   * stops the poll rather than painting an error or a different context.
   */
  readonly deliverPollResponse?: (region: ElementLike, body: string, status: number) => boolean | void;
  /** The host observes outcomes; confirmed commits also refresh the current main partial. */
  readonly onGeneratedFormResult?: (form: ElementLike, result: GeneratedSubmitResult) => void;
  readonly onGeneratedFormError?: (form: ElementLike, error: unknown) => void;
}

export interface BrowserClient {
  /** Re-scan the document for bindable regions (also runs at start). */
  rescan(restartPolling?: boolean): void;
  /** Stop all regions, guards, and listeners. Terminal. */
  stop(): void;
  /** Current context key (`data-can-context` on `<body>`, "" when absent). */
  contextKey(): string;
}

interface BoundRegion {
  readonly element: ElementLike;
  readonly stop: () => void;
  readonly binder: string;
  readonly signature: string;
}

function parseIntervalSeconds(value: string | null): number | null {
  if (value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3600) {
    return null;
  }
  return parsed;
}

/** Native DOM capabilities used by the bounded main-region morph. */
interface DomNode {
  readonly nodeType: number;
  readonly open?: boolean;
  close?(): void;
  nodeValue: string | null;
  readonly childNodes: ArrayLike<DomNode>;
  readonly parentNode?: DomNode | null;
  readonly tagName?: string;
  readonly attributes?: Iterable<{ readonly name: string; readonly value: string }>;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
  querySelector?(selector: string): DomNode | null;
  querySelectorAll?(selector: string): Iterable<DomNode>;
  contains?(other: unknown): boolean;
  focus?(): void;
  cloneNode(deep: boolean): DomNode;
  insertBefore(node: DomNode, before: DomNode | null): DomNode;
  removeChild(node: DomNode): DomNode;
  value?: string;
  readonly defaultValue?: string;
  checked?: boolean;
  readonly defaultChecked?: boolean;
  selected?: boolean;
  readonly defaultSelected?: boolean;
  readonly files?: { readonly length: number } | null;
}

function managedDialog(node: DomNode): boolean {
  return node.tagName?.toLowerCase() === 'dialog' &&
    (node.getAttribute?.('data-can-menu-dialog-panel') != null || node.getAttribute?.('data-can-panel') === 'modal');
}

/** Native close releases modal top-layer/inert state before subtree mutation. */
function closeManagedDialogsIn(node: DomNode): void {
  const panels = [...node.querySelectorAll?.('dialog[data-can-menu-dialog-panel], dialog[data-can-panel="modal"]') ?? []];
  if (managedDialog(node)) panels.unshift(node);
  for (const panel of panels) if (panel.open) panel.close?.();
}

function formIdentity(node: DomNode, generatedOverride?: string): string {
  const id = node.getAttribute?.('id') ?? '';
  const fields = [...node.querySelectorAll?.('input[type="hidden"]') ?? []];
  const field = (name: string) => fields.find((input) => input.getAttribute?.('name') === name)?.getAttribute?.('value') ?? '';
  const refs = fields.filter((input) => input.getAttribute?.('name') !== 'operation_id' && /(?:\[id\]|_id)$/.test(input.getAttribute?.('name') ?? ''))
    .map((input) => [input.getAttribute?.('name'), input.getAttribute?.('value')]).sort();
  const handle = refs.length === 0 && id === '' ? field('action_handle') : '';
  const generated = generatedOverride ?? node.getAttribute?.('data-can-generated-form') ?? null;
  const controls = generated === null ? [] : [...node.querySelectorAll?.('input[id], textarea[id], select[id], button[id]') ?? []]
    .map((control) => [control.getAttribute?.('id'), control.getAttribute?.('name'), control.getAttribute?.('type')]);
  return JSON.stringify([id, node.getAttribute?.('action'), field('operation'), refs, handle, generated, controls]);
}

/** A version refresh may reuse drafts, while its exact authority must be replaced. */
function draftFormIdentity(node: DomNode): string | null {
  if (node.tagName?.toLowerCase() !== 'form') return null;
  try {
    const parsed: unknown = JSON.parse(node.getAttribute?.('data-can-generated-form') ?? '');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const metadata = parsed as Record<string, unknown>;
    if (typeof metadata['draftIdentity'] !== 'string' || metadata['draftIdentity'] === '' ||
        typeof metadata['bindingIdentity'] !== 'string' || metadata['bindingIdentity'] === '') return null;
    const { bindingIdentity: _bindingIdentity, ...draftMetadata } = metadata;
    return formIdentity(node, JSON.stringify(draftMetadata));
  } catch { return null; }
}

function dirtyControl(node: DomNode): boolean {
  return (node.defaultValue !== undefined && node.value !== node.defaultValue) ||
    (node.defaultChecked !== undefined && node.checked !== node.defaultChecked) ||
    [...node.querySelectorAll?.('option') ?? []].some((option) => option.selected !== option.defaultSelected);
}

function transferFormDraft(current: DomNode, next: DomNode, document: DocumentLike): DomNode | null {
  const editable = (node: DomNode) => node.tagName?.toLowerCase() !== 'input' ||
    !['hidden', 'file', 'button', 'reset', 'submit', 'image'].includes(node.getAttribute?.('type')?.toLowerCase() ?? 'text');
  const before = [...current.querySelectorAll?.('input, textarea, select') ?? []].filter(editable);
  const after = [...next.querySelectorAll?.('input, textarea, select') ?? []].filter(editable);
  let focus: DomNode | null = null;
  for (const [index, control] of before.entries()) {
    const replacement = after[index];
    if (replacement === undefined || !compatibleNode(control, replacement)) continue;
    if (document.activeElement === control as unknown as ElementLike) focus = replacement;
    if (!dirtyControl(control)) continue;
    if (control.tagName?.toLowerCase() === 'select') {
      const selected = [...control.querySelectorAll?.('option') ?? []].filter(option => option.selected).map(option => option.value);
      for (const option of replacement.querySelectorAll?.('option') ?? []) option.selected = selected.includes(option.value);
    } else {
      if (control.value !== undefined) replacement.value = control.value;
      if (control.checked !== undefined) replacement.checked = control.checked;
    }
  }
  return focus;
}

function compatibleNode(current: DomNode, next: DomNode): boolean {
  if (current.nodeType !== next.nodeType || current.tagName !== next.tagName) return false;
  const id = next.getAttribute?.('id');
  if (id !== undefined && id !== null && current.getAttribute?.('id') !== id) return false;
  if (['input', 'textarea', 'select'].includes(next.tagName?.toLowerCase() ?? '') &&
      ['id', 'name', 'type'].some((name) => current.getAttribute?.(name) !== next.getAttribute?.(name))) return false;
  if (next.tagName?.toLowerCase() === 'form' && formIdentity(current) !== formIdentity(next)) return false;
  return true;
}

function retainSettledAttrs(attributes: Map<string, string>, current: DomNode, tag: string | undefined): void {
  for (const name of tag === 'form' ? ['aria-busy', 'data-can-submit-state'] :
    tag === 'input' && current.getAttribute?.('type') === 'hidden' ? ['value'] : []) {
    const retained = current.getAttribute?.(name);
    if (retained != null) attributes.set(name, retained);
    else attributes.delete(name);
  }
}

function morphNodeAttributes(
  current: DomNode,
  next: DomNode,
  tag: string | undefined,
  keepForm: boolean,
  settledForm: ElementLike | undefined,
): void {
  const attributes = new Map([...next.attributes ?? []].map((attribute) => [attribute.name, attribute.value]));
  if (managedDialog(current) && current.open) {
    if (settledForm !== undefined && current.contains?.(settledForm) === true) {
      // Removing the open attribute alone leaves a native modal's top layer
      // and document inertness active. Settle it through the native lifecycle.
      current.close?.();
    } else {
      // A background read cannot dismiss an unrelated in-progress dialog.
      attributes.set('open', '');
    }
  }
  if (keepForm || (tag === 'form' && current === (settledForm as unknown))) {
    retainSettledAttrs(attributes, current, tag);
  }
  for (const attribute of [...current.attributes ?? []]) {
    if (!attributes.has(attribute.name)) current.removeAttribute?.(attribute.name);
  }
  for (const [name, value] of attributes) current.setAttribute?.(name, value);
}

function morphNodeChild(
  current: DomNode,
  child: DomNode,
  index: number,
  document: DocumentLike,
  keepForm: boolean,
  settledForm: ElementLike | undefined,
  acceptedInputs: DomNode | undefined,
): void {
  const anchor = current.childNodes[index] ?? null;
  let matched: DomNode | null = null;
  const id = child.getAttribute?.('id');
  if (id !== undefined && id !== null) {
    matched = Array.from(current.childNodes).find((node) => compatibleNode(node, child)) ?? null;
  } else if (anchor !== null && compatibleNode(anchor, child)) matched = anchor;
  if (matched === null) {
    const draftIdentity = draftFormIdentity(child);
    const previous = draftIdentity === null ? null : (id != null
      ? Array.from(current.childNodes).find(node => draftFormIdentity(node) === draftIdentity) ?? null
      : anchor !== null && draftFormIdentity(anchor) === draftIdentity ? anchor : null);
    const replacement = child.cloneNode(true);
    const focus = previous === null ? null : transferFormDraft(previous, replacement, document);
    current.insertBefore(replacement, anchor);
    if (previous !== null) {
      releaseMountsIn(previous);
      current.removeChild(previous);
    }
    focus?.focus?.();
  }
  else {
    if (matched !== anchor) current.insertBefore(matched, anchor);
    morphNode(matched, child, document, keepForm, settledForm, acceptedInputs);
  }
}

function morphRestoreControl(
  current: DomNode,
  next: DomNode,
  tag: string | undefined,
  keepInput: boolean,
  keepForm: boolean,
  value: string | undefined,
  checked: boolean | undefined,
  selected: Array<string | undefined> | null,
): void {
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    if (tag !== 'select' && current.getAttribute?.('type') !== 'file' && value !== undefined) current.value =
      keepInput || (keepForm && current.getAttribute?.('type') === 'hidden') ? value : next.value ?? '';
    if (checked !== undefined) current.checked = keepInput ? checked : next.checked ?? false;
    if (selected !== null) {
      for (const option of current.querySelectorAll?.('option') ?? []) option.selected = selected.includes(option.value);
    }
  }
}

function morphKeepInput(
  tag: string | undefined,
  acceptedInputs: DomNode | undefined,
  document: DocumentLike,
  current: DomNode,
): boolean {
  const editable = (tag === 'input' && current.getAttribute?.('type') !== 'hidden') || tag === 'textarea' || tag === 'select';
  return editable && acceptedInputs?.contains?.(current) !== true && (document.activeElement === current as unknown as ElementLike ||
    (current.files?.length ?? 0) > 0 || dirtyControl(current));
}

function selectedOptionValues(source: DomNode, next: DomNode, tag: string | undefined, keepInput: boolean): Array<string | undefined> | null {
  if (tag !== 'select') return null;
  return [...(keepInput ? source : next).querySelectorAll?.('option') ?? []].filter((option) => option.selected).map((option) => option.value);
}

function morphNodeHead(
  current: DomNode,
  next: DomNode,
  document: DocumentLike,
  generatedForm: boolean,
  settledForm: ElementLike | undefined,
  acceptedInputs: DomNode | undefined,
): {
  tag: string | undefined; keepForm: boolean; keepInput: boolean;
  value: string | undefined; checked: boolean | undefined; selected: Array<string | undefined> | null;
} | undefined {
  if (current.nodeType !== 1) { current.nodeValue = next.nodeValue; return undefined; }
  const generatedUseId = current.getAttribute?.(GENERATED_VIEW_ATTR);
  if (generatedUseId) {
    releaseGeneratedViewMount(generatedUseId);
    generatedViewRebinds.add(current);
  }
  const tag = current.tagName?.toLowerCase();
  // Exact metadata includes the comparison-only binding identity. Keeping the
  // occurrence retains its nonce/token/CSRF/version set and submit lifecycle.
  const keepForm = current !== (settledForm as unknown) && (generatedForm || (tag === 'form' && current.getAttribute?.('data-can-generated-form') != null));
  if (keepForm && current.getAttribute?.('data-can-form-feedback') != null) return undefined;
  const keepInput = morphKeepInput(tag, acceptedInputs, document, current);
  const value = current.value;
  const checked = current.checked;
  const selected = selectedOptionValues(current, next, tag, keepInput);
  return { tag, keepForm, keepInput, value, checked, selected };
}

function trimNodeChildren(current: DomNode, desired: readonly DomNode[]): void {
  while (current.childNodes.length > desired.length) {
    const last = current.childNodes[current.childNodes.length - 1];
    if (last === undefined) {
      break;
    }
    releaseMountsIn(last);
    current.removeChild(last);
  }
}

function morphNode(current: DomNode, next: DomNode, document: DocumentLike, generatedForm = false, settledForm?: ElementLike, acceptedInputs?: DomNode): void {
  const head = morphNodeHead(current, next, document, generatedForm, settledForm, acceptedInputs);
  if (head === undefined) return;
  const { tag, keepForm, keepInput, value, checked, selected } = head;
  morphNodeAttributes(current, next, tag, keepForm, settledForm);
  const desired = Array.from(next.childNodes);
  for (const [index, child] of desired.entries()) {
    morphNodeChild(current, child, index, document, keepForm, settledForm, acceptedInputs);
  }
  trimNodeChildren(current, desired);
  morphRestoreControl(current, next, tag, keepInput, keepForm, value, checked, selected);
}

/** Mark a failed reread without replacing still-authorized content or drafts. */
function markReadFailure(document: DocumentLike, region: ElementLike): void {
  if (region.hasAttribute('data-can-read-denied')) return;
  region.setAttribute('data-can-stale', 'true');
  const id = region.getAttribute('id') ?? '';
  const root = region as unknown as DomNode;
  if ([...root.querySelectorAll?.('[data-stale-region]') ?? []].some(node =>
    node.getAttribute?.('data-stale-region') === id)) return;
  const marker = document.createElement?.('div') as (DomNode & { textContent: string | null }) | undefined;
  if (marker === undefined) return;
  marker.setAttribute?.('role', 'alert');
  marker.setAttribute?.('class', 'badge badge-warning');
  marker.setAttribute?.('data-stale-region', id);
  marker.textContent = 'This page could not be refreshed. The displayed information may be out of date.';
  root.insertBefore(marker, root.childNodes[0] ?? null);
}

/** An admitted denial must discard private values as well as their controls. */
function withdrawPollRegion(document: DocumentLike, region: ElementLike): void {
  // Set the barrier before cleanup: other pending reads from this context
  // cannot restore a projection after its current admission was denied.
  region.setAttribute('data-can-read-denied', 'true');
  region.removeAttribute('data-can-poll');
  region.removeAttribute('data-can-stale');
  const root = region as unknown as DomNode;
  // A saved mount cleanup can fail; every private subtree must still detach.
  releaseClientResources(Array.from(root.childNodes, child => () => {
    try { releaseMountsIn(child); }
    finally { root.removeChild(child); }
  }));
  const notice = document.createElement?.('p') as (DomNode & { textContent: string | null }) | undefined;
  if (notice === undefined) return;
  notice.setAttribute?.('role', 'alert');
  notice.textContent = 'This page is no longer available.';
  root.insertBefore(notice, null);
}

function checkPollBody(document: DocumentLike, region: ElementLike, body: string): DomNode | null {
  if (document.createElement === undefined) return null;
  const template = document.createElement('template') as { innerHTML: string; readonly content: DomNode };
  template.innerHTML = body;
  const significant = Array.from(template.content.childNodes).filter((node) => node.nodeType === 1 || (node.nodeValue ?? '').trim() !== '');
  const incoming = significant[0];
  if (significant.length !== 1 || incoming?.tagName?.toLowerCase() !== 'main' || incoming.getAttribute?.('id') !== region.getAttribute('id') ||
      incoming.getAttribute?.('data-can-context') !== region.getAttribute('data-can-context') ||
      incoming.getAttribute?.('data-can-poll-context') !== region.getAttribute('data-can-poll-context') || incoming.querySelector?.('script') !== null) return null;
  return incoming;
}

/** Accept one same-context main partial; a settled form may adopt fresh request authority. */
export function applyPollResponse(document: DocumentLike, region: ElementLike, body: string, status: number, settledForm?: ElementLike): boolean {
  if (region.hasAttribute('data-can-read-denied')) return false;
  if (status === 403) {
    withdrawPollRegion(document, region);
    return false;
  }
  if (status < 200 || status >= 300 || /<!doctype|<\/?(?:html|head|body)(?:\s|>)/i.test(body)) {
    markReadFailure(document, region);
    return false;
  }
  const incoming = checkPollBody(document, region, body);
  if (incoming === null) { markReadFailure(document, region); return false; }
  const root = region as unknown as DomNode;
  // This client-owned sibling is not part of the server's child sequence.
  // Remove it only after admitting a fresh partial, before positional morphing
  // can mistake the shifted old content for replacement nodes and lose drafts.
  const regionId = region.getAttribute('id') ?? '';
  for (const child of Array.from(root.childNodes)) {
    if (child.getAttribute?.('data-stale-region') === regionId) root.removeChild(child);
  }
  morphNode(root, incoming, document, false, settledForm);
  return true;
}

function bindPollRegion(
  region: ElementLike,
  client: BrowserClient,
  internals: ClientInternals,
): () => void {
  const url = region.getAttribute("data-can-poll-url");
  const interval = parseIntervalSeconds(region.getAttribute("data-can-poll-interval"));
  const context = client.contextKey();
  if (url === null || url === "" || interval === null || internals.visibility.visibilityState === 'hidden' ||
      (internals.windowRef.location.pathname !== undefined && url.split('?')[0] !== internals.windowRef.location.pathname)) {
    return () => {};
  }
  const poller = new PollRegion({
    url,
    intervalSeconds: interval,
    contextKey: context,
    fetchImpl: submitFetchPollFetch(internals.fetchImpl),
    timers: internals.windowRef,
    visibility: internals.visibility,
    context: {
      key: () => client.contextKey(),
      isAlive: () => region.isConnected,
    },
    isLoggedOut: () => region.getAttribute("data-can-logged-out") === "true" || internals.document.body?.getAttribute("data-can-logged-out") === "true",
    onResponse: (body, status) => {
      const applied = status === 403 || internals.deliver === undefined
        ? applyPollResponse(internals.document, region, body, status)
        : internals.deliver(region, body, status);
      if (status === 403 || applied !== false) client.rescan();
      return applied;
    },
    onError: () => markReadFailure(internals.document, region),
  });
  poller.start();
  return () => {
    poller.stop("owner-stop");
  };
}

function bindGuardedForm(
  form: ElementLike,
  _client: BrowserClient,
  internals: ClientInternals,
): () => void {
  const windowRef = internals.windowRef;
  let dirty = false;
  const onInput = (): void => {
    dirty = true;
  };
  const onSubmit = (): void => {
    dirty = false;
  };
  const onBeforeUnload = (event: EventLike): void => {
    if (dirty) {
      event.preventDefault();
    }
  };
  form.addEventListener("input", onInput);
  form.addEventListener("submit", onSubmit);
  windowRef.addEventListener("beforeunload", onBeforeUnload);
  return () => {
    form.removeEventListener("input", onInput);
    form.removeEventListener("submit", onSubmit);
    windowRef.removeEventListener("beforeunload", onBeforeUnload);
  };
}

/** Source forms submit through the existing projection, never native bracket expansion. */
/** Assistance owns no submission path: selections only edit the existing controls. */
function bindInputChoices(form: ElementLike, internals: ClientInternals, alive: () => boolean): () => void {
  type Control = ElementLike & { name: string; value: string; checked: boolean; type: string };
  type Select = ElementLike & { value: string; textContent: string | null; appendChild(child: unknown): unknown };
  let metadata: {
    derived?: DerivedOperationInputs; mode?: FormMode; renderedInputs?: readonly string[];
  };
  try { metadata = JSON.parse(form.getAttribute('data-can-generated-form') ?? '{}'); }
  catch { return () => {}; }
  if (!metadata || !metadata.derived || !metadata.mode) return () => {};
  const derived = metadata.derived;
  const mode = metadata.mode;
  const controls = () => Array.from((form as ElementLike & { elements: ArrayLike<Control> }).elements);
  const root = (name: string) => mode === 'update' ? `inputs[changes][${name}]` : `inputs[${name}]`;
  const flat = (): Record<string, string> => {
    const result: Record<string, string> = {};
    const FormData = internals.windowRef.FormData;
    if (!FormData) throw new Error('Native FormData is unavailable.');
    for (const [name, value] of new FormData(form)) if (typeof value === 'string') result[name] = value;
    return result;
  };
  const entries = Array.from(form.querySelectorAll?.('[data-can-choices]') ?? []).map(outlet => {
    const input = derived.inputs.find(input => input.name === outlet.getAttribute('data-can-choices'));
    const select = outlet.querySelector?.('[data-can-choices-select]') as Select | null;
    const feedback = outlet.querySelector?.('[data-can-choices-feedback]') as (ElementLike & { textContent: string | null }) | null;
    return { input, select, feedback, sequence: 0, values: [] as unknown[],
      timer: null as unknown | null, inflight: null as AbortController | null };
  });
  let stopped = false;
  const current = () => !stopped && alive();
  const reset = (entry: typeof entries[number], message = '') => {
    if (entry.timer !== null) internals.windowRef.clearTimeout(entry.timer);
    entry.timer = null;
    entry.inflight?.abort();
    entry.inflight = null;
    entry.sequence++;
    entry.values = [];
    if (entry.select) {
      entry.select.textContent = '';
      entry.select.setAttribute('disabled', '');
      entry.select.removeAttribute('aria-busy');
      const option = internals.document.createElement?.('option') as { value: string; textContent: string } | undefined;
      if (option) { option.value = ''; option.textContent = 'Choose a value'; entry.select.appendChild(option); }
    }
    if (entry.feedback) entry.feedback.textContent = message;
  };
  const clear = (name: string) => {
    for (const control of controls()) {
      if ([root(name), root(name + GENERATED_REF_VERSION_SUFFIX), root(name + GENERATED_NULL_SUFFIX)].includes(control.name)) {
        control.value = control.type === 'checkbox' ? 'true' : '';
        if (control.type === 'checkbox') control.checked = false;
      }
    }
  };
  const parents = (entry: typeof entries[number]) => [...new Set(Object.values(entry.input?.choices?.arguments ?? {}).map(mapping => mapping.input))];
  const request = (entry: typeof entries[number]): { key: string; body: string; csrf: string } | null => {
    const draft = flat();
    const names = parents(entry);
    const protectedRoot = (name: string) => Boolean(draft[SOURCE_FORM_BINDING_FIELD]) &&
      !controls().some(control => control.name === root(name));
    const editable = names.filter(name => !protectedRoot(name));
    if (editable.some(name => !derived.inputs.some(input => input.name === name && input.kind !== 'delivery') ||
        !controls().some(control => control.name === root(name)))) return null;
    const present = editable.filter(name => draft[root(name + GENERATED_NULL_SUFFIX)] !== 'true' &&
      (draft[root(name)] !== undefined && draft[root(name)] !== '' ||
       controls().some(control => control.name === root(name) && control.type === 'checkbox')));
    if (present.length !== editable.length) return null;
    if (editable.some(name => {
      const input = derived.inputs.find(input => input.name === name);
      return input?.kind === 'ref' && input.versioned === true && !draft[root(name + GENERATED_REF_VERSION_SUFFIX)];
    })) return null;
    const projected = projectGeneratedInputs(derived, mode, draft, present);
    const inputs = Object.fromEntries(editable.map(name => [name, projected[name]]));
    if (Object.values(inputs).some(value => value === null || value === undefined || value === '' || Array.isArray(value) && value.length === 0)) return null;
    if (!draft.operation_id || !draft[CSRF_FIELD]) return null;
    const body = JSON.stringify({ operation_id: draft.operation_id, inputs,
      ...(draft[SOURCE_FORM_BINDING_FIELD] === undefined ? {} : { [SOURCE_FORM_BINDING_FIELD]: draft[SOURCE_FORM_BINDING_FIELD] }) });
    return { key: JSON.stringify([body, draft[CSRF_FIELD], form.getAttribute('action')]), body, csrf: draft[CSRF_FIELD] };
  };
  const choiceBlocked = (entry: typeof entries[number], input: DerivedWritableInput): boolean => {
    if (input.array || !['ref', 'user', 'string', 'integer', 'decimal', 'duration', 'boolean', 'enum'].includes(input.kind)) return true;
    if (parents(entry).some(name => {
      const parent = derived.inputs.find(input => input.name === name);
      return !parent || parent.array !== undefined || ['file', 'delivery'].includes(parent.kind);
    })) return true;
    if (!controls().some(control => control.name === root(input.name))) return true;
    return input.kind === 'ref' && input.versioned === true &&
      !controls().some(control => control.name === root(input.name + GENERATED_REF_VERSION_SUFFIX));
  };
  const isReferenceChoiceValue = (input: DerivedWritableInput, value: object): boolean => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (typeof (value as { id?: unknown }).id !== 'string' || (value as { id: string }).id === '') return false;
    if (Object.keys(value).some(key => key !== 'id' && !(input.versioned && key === 'version'))) return false;
    return !input.versioned ||
      (typeof (value as { version?: unknown }).version === 'string' && (value as { version: string }).version !== '');
  };
  const choiceValueValid = (input: DerivedWritableInput, value: unknown): boolean => {
    if (value === null) return input.nullable === true;
    if (input.kind === 'ref' || input.kind === 'user') return typeof value === 'object' && isReferenceChoiceValue(input, value as object);
    if (input.kind === 'boolean') return typeof value === 'boolean';
    return typeof value === 'string';
  };
  const checkChoiceCandidate = (input: DerivedWritableInput, candidate: { labels: unknown; value: unknown }): unknown => {
    if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.labels) ||
        (candidate.labels as unknown[]).some((label: unknown) => typeof label !== 'string')) throw new Error('Invalid choice label.');
    const value: unknown = candidate.value;
    if (!choiceValueValid(input, value)) throw new Error('Invalid choice value.');
    if (value !== null && input.kind === 'enum' && !input.enumValues?.includes(value as string)) throw new Error('Invalid enum choice.');
    return value;
  };
  const appendChoiceCandidate = (entry: typeof entries[number], input: DerivedWritableInput, candidate: { labels: unknown; value: unknown }): void => {
    const value = checkChoiceCandidate(input, candidate);
    const option = internals.document.createElement?.('option') as { value: string; textContent: string } | undefined;
    if (!option) throw new Error('Native option creation is unavailable.');
    option.value = String(entry.values.length);
    option.textContent = (candidate as { labels: string[] }).labels.join(' · ');
    entry.values.push(value);
    entry.select!.appendChild(option);
  };
  const fetchChoiceResponse = async (
    entry: typeof entries[number],
    input: DerivedWritableInput,
    sent: { key: string; body: string; csrf: string },
    sequence: number,
    controller: AbortController,
  ): Promise<Array<{ labels: unknown; value: unknown }> | null> => {
    const response = await internals.fetchImpl(`${form.getAttribute('action') ?? ''}/choices/${encodeURIComponent(input.name)}`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': sent.csrf }, body: sent.body,
      signal: controller.signal,
    });
    const body: unknown = JSON.parse(await response.text());
    if (!current() || sequence !== entry.sequence || request(entry)?.key !== sent.key) return null;
    if (response.status < 200 || response.status >= 300 || !body || typeof body !== 'object') throw new Error('Choice lookup failed.');
    const result = body as { state?: unknown; choices?: unknown };
    if (!['ready', 'absent'].includes(String(result.state)) || !Array.isArray(result.choices)) throw new Error('Invalid choices response.');
    if (result.state === 'absent') {
      if (entry.feedback) entry.feedback.textContent = 'Choose the required values first.';
      return null;
    }
    return result.choices;
  };
  const lookup = async (entry: typeof entries[number]) => {
    reset(entry);
    const input = entry.input;
    if (!input?.choices || !entry.select) return;
    if (choiceBlocked(entry, input)) {
      reset(entry, 'Choice assistance is unavailable for this input. Use its value controls.'); return;
    }
    const sequence = entry.sequence;
    let controller: AbortController | null = null;
    try {
      const sent = request(entry);
      if (!current()) return;
      if (!sent) {
        if (entry.feedback) entry.feedback.textContent = 'Choose the required values first.';
        return;
      }
      controller = new AbortController();
      entry.inflight = controller;
      entry.select.setAttribute('aria-busy', 'true');
      if (entry.feedback) entry.feedback.textContent = 'Loading choices…';
      const choices = await fetchChoiceResponse(entry, input, sent, sequence, controller);
      if (choices === null) return;
      for (const candidate of choices) {
        appendChoiceCandidate(entry, input, candidate);
      }
      if (entry.values.length > 0) entry.select.removeAttribute('disabled');
      if (entry.feedback) entry.feedback.textContent = entry.values.length === 0
        ? 'No choices available.' : `${entry.values.length} choices available.`;
    } catch {
      if (current() && sequence === entry.sequence) reset(entry, 'Choices could not be loaded. Use the value controls or try again.');
    } finally {
      if (entry.inflight === controller) entry.inflight = null;
      if (current() && sequence === entry.sequence) entry.select.removeAttribute('aria-busy');
    }
  };
  const schedule = (entry: typeof entries[number]) => {
    reset(entry);
    entry.timer = internals.windowRef.setTimeout(() => {
      entry.timer = null;
      if (current()) void lookup(entry);
    }, 150);
  };
  const changed = (name: string) => {
    const affected = new Set([name]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const entry of entries) if (entry.input && !affected.has(entry.input.name) && parents(entry).some(parent => affected.has(parent))) {
        affected.add(entry.input.name); clear(entry.input.name); reset(entry); expanded = true;
      }
    }
    for (const entry of entries) if (entry.input && affected.has(entry.input.name) && entry.input.name !== name) schedule(entry);
  };
  const listeners: Array<readonly [ElementLike, string, (event: EventLike) => void]> = [];
  for (const control of controls()) {
    const input = derived.inputs.find(input => [root(input.name), root(input.name + GENERATED_REF_VERSION_SUFFIX), root(input.name + GENERATED_NULL_SUFFIX)].includes(control.name));
    if (!input) continue;
    const listener = () => {
      for (const entry of entries) if (entry.input?.name === input.name && entry.select) entry.select.value = '';
      changed(input.name);
    };
    for (const type of ['input', 'change']) { control.addEventListener(type, listener); listeners.push([control, type, listener]); }
  }
  for (const entry of entries) {
    if (!entry.select || !entry.input) continue;
    const listener = () => {
      if (!current() || entry.select!.value === '') return;
      const value = entry.values[Number(entry.select!.value)];
      if (value === undefined) return;
      clear(entry.input!.name);
      for (const control of controls()) {
        if (control.name === root(entry.input!.name + GENERATED_NULL_SUFFIX)) control.checked = value === null;
        if (value === null) continue;
        if (control.name === root(entry.input!.name)) {
          control.value = typeof value === 'object' ? (value as { id: string }).id : String(value);
          if (control.type === 'checkbox') control.checked = value === true;
        }
        if (control.name === root(entry.input!.name + GENERATED_REF_VERSION_SUFFIX) && typeof value === 'object') control.value = (value as { version?: string }).version ?? '';
      }
      changed(entry.input!.name);
    };
    entry.select.addEventListener('change', listener); listeners.push([entry.select, 'change', listener]);
    void lookup(entry);
  }
  return () => { stopped = true; for (const [element, type, listener] of listeners) element.removeEventListener(type, listener); for (const entry of entries) reset(entry); };
}

function bindGeneratedForm(form: ElementLike, client: BrowserClient, internals: ClientInternals): () => void {
  const context = client.contextKey();
  let stopped = false;
  let pending = false;
  let previousBusy: string | null = null;
  const alive = () => !stopped && form.isConnected && client.contextKey() === context;
  const feedback = (code: string | null, message: string): void => {
    const outlet = form.querySelector?.('[data-can-form-feedback]') as (ElementLike & { textContent: string | null }) | null | undefined;
    if (outlet === null || outlet === undefined) return;
    outlet.textContent = message;
    if (code === null) {
      outlet.setAttribute('hidden', '');
      outlet.removeAttribute('data-can-form-feedback-code');
    } else {
      outlet.removeAttribute('hidden');
      outlet.setAttribute('data-can-form-feedback-code', code);
    }
  };
  const releaseBusy = () => {
    if (previousBusy === null) form.removeAttribute('aria-busy');
    else form.setAttribute('aria-busy', previousBusy);
  };
  let restoreSubmitter: (() => void) | undefined;
  let inflight: AbortController | null = null;
  const parseSubmitMetadata = (): {
    deletion: { operation?: unknown } | null;
    metadata: { derived?: DerivedOperationInputs; mode?: FormMode; renderedInputs?: readonly string[] } | null;
  } => {
    const deleteMetadata = form.getAttribute('data-can-delete-form');
    const deletion = deleteMetadata === null ? null : JSON.parse(deleteMetadata) as { operation?: unknown };
    if (deletion !== null && (typeof deletion.operation !== 'string' || deletion.operation === '')) {
      throw new GeneratedSubmitError('usage', 'Delete form submit metadata is unavailable.', false);
    }
    const metadata = deletion !== null ? null : JSON.parse(form.getAttribute('data-can-generated-form') ?? '') as {
      derived?: DerivedOperationInputs; mode?: FormMode; renderedInputs?: readonly string[];
    } | null;
    if (deletion === null && (metadata?.derived === undefined || typeof metadata.derived.operation !== 'string' ||
        !Array.isArray(metadata.derived.inputs) ||
        !['create', 'update', 'scenario'].includes(metadata.mode ?? '') ||
        (metadata.renderedInputs !== undefined && (!Array.isArray(metadata.renderedInputs) ||
          metadata.renderedInputs.some(name => typeof name !== 'string'))))) {
      throw new GeneratedSubmitError('usage', 'Form submit metadata is unavailable.', false);
    }
    return { deletion, metadata };
  };
  const collectSubmitFlat = (event: EventLike): Record<string, string> => {
    const FormData = internals.windowRef.FormData;
    if (FormData === undefined) throw new GeneratedSubmitError('usage', 'Native FormData is unavailable.', false);
    const controls = (form as ElementLike & { readonly elements: ArrayLike<DomControlLike & {
      readonly disabled?: boolean; matches?(selector: string): boolean;
    }> }).elements;
    for (const control of Array.from(controls)) {
      if (!control.disabled && control.matches?.(':disabled') !== true && (control.files?.length ?? 0) > 0) {
        throw new GeneratedSubmitError('usage', 'File submission needs its supplied upload intents route.', false);
      }
    }
    const flat: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [name, value] of new FormData(form, event.submitter)) {
      if (typeof value === 'string') flat[name] = value;
    }
    return flat;
  };
  const applySubmitRetry = (flat: Record<string, string>, retry: { operation_id: string; form_binding?: string }): void => {
    type Hidden = ElementLike & { value: string };
    const oneHidden = (name: string): Hidden => {
      const matches = [...form.querySelectorAll?.(`input[name="${name}"]`) ?? []];
      const control = matches[0] as Hidden | undefined;
      if (matches.length !== 1 || control?.getAttribute('type') !== 'hidden' ||
          control.value !== flat[name] || control.getAttribute('value') !== flat[name]) {
        throw new GeneratedSubmitError('contract', 'Submitted form retry metadata changed.', false);
      }
      return control;
    };
    oneHidden('operation');
    const nonce = oneHidden('operation_id');
    const binding = retry.form_binding === undefined ? undefined : oneHidden(SOURCE_FORM_BINDING_FIELD);
    if (binding === undefined && [...form.querySelectorAll?.(`input[name="${SOURCE_FORM_BINDING_FIELD}"]`) ?? []].length !== 0) {
      throw new GeneratedSubmitError('contract', 'Submitted form retry metadata changed.', false);
    }
    // All response and live-pair checks precede either metadata update.
    nonce.value = retry.operation_id;
    nonce.setAttribute('value', retry.operation_id);
    if (binding !== undefined) {
      binding.value = retry.form_binding!;
      binding.setAttribute('value', retry.form_binding!);
    }
  };
  const settleSubmitResult = (flat: Record<string, string>, result: GeneratedSubmitResult, automatic = false): void => {
    if (result.kind === 'denied' && result.retry !== undefined) {
      applySubmitRetry(flat, result.retry);
    }
    form.setAttribute('data-can-submit-state', result.kind);
    if (result.kind === 'denied') {
      feedback(result.error.code, [
        result.error.message,
        ...(result.error.fields ?? []).map(field => field.message),
      ].join('\n'));
    }
    internals.onGeneratedFormResult?.(form, result, automatic);
  };
  const refreshRegion = internals.document.getElementById('can-main');
  const refreshOperation = refreshRegion?.getAttribute('data-can-refresh');
  const cadence = parseIntervalSeconds(refreshRegion?.getAttribute('data-can-poll-interval') ?? null);
  let repeat: { flat: Record<string, string>; metadata: NonNullable<ReturnType<typeof parseSubmitMetadata>['metadata']>; action: string } | null = null;
  let timer: unknown = null;
  let failures = 0;
  let repeatGeneration = 0;
  let repeatRequest: AbortController | null = null;
  const repeatAlive = () => alive() && refreshRegion !== null && refreshRegion?.isConnected === true &&
    internals.document.getElementById('can-main') === refreshRegion &&
    refreshRegion.getAttribute('data-can-refresh') === refreshOperation &&
    !refreshRegion.hasAttribute('data-can-read-denied') && internals.visibility.visibilityState === 'visible' &&
    internals.document.body?.getAttribute('data-can-logged-out') !== 'true' &&
    refreshRegion.getAttribute('data-can-logged-out') !== 'true';
  const clearRepeat = () => {
    if (timer !== null) internals.windowRef.clearTimeout(timer);
    timer = null; repeat = null; failures = 0; repeatGeneration += 1;
    repeatRequest?.abort(); repeatRequest = null;
  };
  const refreshEligible = (metadata: ReturnType<typeof parseSubmitMetadata>['metadata'], flat: Record<string, string>): boolean =>
    cadence !== null && refreshOperation != null && metadata?.mode === 'scenario' &&
    metadata.derived?.operation === refreshOperation && flat.operation === refreshOperation &&
    metadata.derived.inputs.every(input => !['ref', 'file', 'delivery'].includes(input.kind) &&
      (input.default === undefined || input.default.kind === 'literal'));
  const scheduleRepeat = () => {
    if (repeat === null || cadence === null || !repeatAlive()) { clearRepeat(); return; }
    // Completion-based cadence coalesces missed ticks: no queued invocations.
    timer = internals.windowRef.setTimeout(() => { timer = null; void runRepeat(); },
      Math.min(3600000, cadence * 1000 * 2 ** Math.min(failures, 8)));
  };
  const acceptRepeat = (entry: NonNullable<typeof repeat>, result: GeneratedSubmitResult): void => {
    if (result.kind === 'denied' && result.error.retryable === true && ![401, 403].includes(result.status)) {
      repeat = result.retry === undefined ? entry : { ...entry, flat: { ...entry.flat,
        operation_id: result.retry.operation_id,
        ...(result.retry.form_binding === undefined ? {} : { [SOURCE_FORM_BINDING_FIELD]: result.retry.form_binding }) } };
      failures = Math.min(failures + 1, 8); return;
    }
    if (result.kind !== 'committed' || result.result.operation_id !== entry.flat.operation_id) {
      clearRepeat(); return;
    }
    const deliveries = result.result.deliveries;
    if (deliveries !== undefined && (!Array.isArray(deliveries) || deliveries.some(delivery =>
        typeof delivery?.id !== 'string' || !['pending', 'unknown', 'succeeded', 'failed', 'skipped'].includes(delivery.status)))) {
      clearRepeat(); return;
    }
    // Pending/unknown source work may only replay its exact occurrence.
    // The canonical receipt reader decides whether terminal evidence exists.
    if (deliveries?.some(delivery => delivery.status === 'pending' || delivery.status === 'unknown')) {
      repeat = entry; failures = Math.min(failures + 1, 8); return;
    }
    const next = result.result.refresh;
    if (next === undefined) { clearRepeat(); return; }
    applySubmitRetry(entry.flat, next);
    feedback(null, '');
    repeat = { ...entry, flat: { ...entry.flat, operation_id: next.operation_id,
      ...(next.form_binding === undefined ? {} : { [SOURCE_FORM_BINDING_FIELD]: next.form_binding }) } };
    failures = deliveries?.some(delivery => delivery.status === 'failed') ? Math.min(failures + 1, 8) : 0;
  };
  const hideSourceHandles = () => {
    for (const handle of refreshRegion?.querySelectorAll?.('[data-can-once], [data-can-source-action]') ?? []) {
      handle.setAttribute('hidden', '');
    }
  };
  const runRepeat = async (): Promise<void> => {
    const entry = repeat;
    if (entry === null || !repeatAlive()) { clearRepeat(); return; }
    if (pending) { scheduleRepeat(); return; }
    pending = true;
    previousBusy = form.getAttribute('aria-busy');
    form.setAttribute('aria-busy', 'true');
    form.setAttribute('data-can-submit-state', 'pending');
    const controller = new AbortController(); inflight = controller; repeatRequest = controller;
    internals.onGeneratedFormStart?.(); hideSourceHandles();
    try {
      const csrf = form.querySelector?.(`input[name="${CSRF_FIELD}"]`) as (ElementLike & { value: string }) | null;
      if (typeof csrf?.value !== 'string' || csrf.value === '' || form.getAttribute('action') !== entry.action) {
        clearRepeat(); return;
      }
      const flat = { ...entry.flat, [CSRF_FIELD]: csrf.value };
      const result = await submitGeneratedForm({ derived: entry.metadata.derived!, mode: entry.metadata.mode!, flat,
        ...(entry.metadata.renderedInputs === undefined ? {} : { renderedInputs: entry.metadata.renderedInputs }),
        action: entry.action, fragment: false, denialFormat: 'json', refresh: true,
        fetchImpl: (url, init) => {
          if (!repeatAlive() || repeat !== entry) throw new GeneratedSubmitError('transport', 'Refresh owner ended.', false);
          return internals.fetchImpl(url, { ...init, signal: controller.signal });
        } });
      if (repeat !== entry || !repeatAlive()) return;
      acceptRepeat(entry, result);
      // The same canonical feedback/reread owner handles results. No result
      // calls the repeat trigger; only the serial timer can issue its next POST.
      settleSubmitResult(entry.flat, result, true);
    } catch (error) {
      if (repeat === entry && repeatAlive()) {
        failures = Math.min(failures + 1, 8);
        form.setAttribute('data-can-submit-state', 'error');
        feedback('submit_failed', 'The refresh could not be confirmed. Retrying the same request.');
        internals.onGeneratedFormError?.(form, error);
      }
    } finally {
      inflight = null; repeatRequest = null; pending = false;
      if (!stopped) releaseBusy();
      scheduleRepeat();
    }
  };
  const onSubmit = (event: EventLike): void => {
    event.preventDefault();
    event.stopPropagation?.();
    if (pending || !alive()) return;
    clearRepeat();
    internals.claimRefresh?.(clearRepeat);
    const explicitGeneration = repeatGeneration;
    internals.onGeneratedFormStart?.();
    feedback(null, '');
    pending = true;
    previousBusy = form.getAttribute('aria-busy');
    form.setAttribute('aria-busy', 'true');
    form.setAttribute('data-can-submit-state', 'pending');
    void (async () => {
      try {
        const { deletion, metadata } = parseSubmitMetadata();
        const flat = collectSubmitFlat(event);
        const eligible = refreshEligible(metadata, flat);
        if (eligible) hideSourceHandles();
        const controller = new AbortController();
        inflight = controller;
        // FormData must collect the activated successful control before it is
        // disabled. The owning transport settles this exact submit occurrence.
        const submitter = event.submitter;
        if (submitter !== undefined && submitter !== null) {
          const disabled = submitter.getAttribute('disabled');
          const ariaDisabled = submitter.getAttribute('aria-disabled');
          restoreSubmitter = () => {
            restoreSubmitter = undefined;
            releaseClientResources(([['disabled', disabled], ['aria-disabled', ariaDisabled]] as const).map(([name, value]) => () => {
              if (value === null) submitter.removeAttribute(name);
              else submitter.setAttribute(name, value);
            }));
          };
          submitter.setAttribute('disabled', '');
          submitter.setAttribute('aria-disabled', 'true');
        }
        const fetchImpl: SubmitFetch = (url, init) => {
          if (!alive()) throw new GeneratedSubmitError('transport', 'Form submit owner is no longer active.', false);
          return internals.fetchImpl(url, { ...init, signal: controller.signal });
        };
        const result = deletion !== null
          ? await submitDeleteForm({ operation: deletion.operation as string, flat, action: form.getAttribute('action') ?? '', fetchImpl })
          : await submitGeneratedForm({
              derived: metadata!.derived!, mode: metadata!.mode!, flat,
              ...(metadata!.renderedInputs === undefined ? {} : { renderedInputs: metadata!.renderedInputs }),
              action: form.getAttribute('action') ?? '', fragment: false, denialFormat: 'json', refresh: eligible, fetchImpl,
            });
        if (alive()) {
          if (eligible && metadata !== null && repeatGeneration === explicitGeneration && repeatAlive()) {
            acceptRepeat({ flat: { ...flat }, metadata: JSON.parse(JSON.stringify(metadata)) as typeof metadata,
              action: form.getAttribute('action') ?? '' }, result);
          }
          settleSubmitResult(flat, result);
        }
      } catch (error) {
        if (alive()) {
          form.setAttribute('data-can-submit-state', 'error');
          const projection = error instanceof GeneratedSubmitError && error.code === 'projection';
          feedback(projection ? 'projection' : 'submit_failed', projection
            ? error.message : 'The submission could not be confirmed. Please try again.');
          internals.onGeneratedFormError?.(form, error);
        }
      } finally {
        inflight = null;
        pending = false;
        scheduleRepeat();
        releaseClientResources([
          ...(alive() ? [() => restoreSubmitter?.()] : []),
          ...(!stopped ? [releaseBusy] : []),
        ]);
      }
    })();
  };
  const stopChoices = bindInputChoices(form, internals, alive);
  form.addEventListener('submit', onSubmit);
  return () => {
    stopped = true;
    clearRepeat();
    const request = inflight;
    inflight = null;
    // Release this owner's temporary state before a replacement binds the
    // same connected form. Its later settlement cannot restore twice.
    releaseClientResources([
      () => restoreSubmitter?.(),
      () => request?.abort(),
      stopChoices,
      () => form.removeEventListener('submit', onSubmit),
      ...(pending ? [releaseBusy, () => form.removeAttribute('data-can-submit-state')] : []),
    ]);
  };
}

function checkPreferenceResponse(
  document: DocumentLike,
  incoming: DomNode,
  main: ElementLike | null,
  nextMain: (DomNode & { outerHTML: string }) | null,
  form: ElementLike,
  field: ElementLike | null,
  fieldName: string | null | undefined,
  panel: ElementLike | undefined,
  sidebar: ElementLike | undefined,
  nextPanel: DomNode | null | undefined,
  nextSidebar: DomNode | null | undefined,
  nextField: DomNode | undefined,
  status: number,
): boolean {
  if (!main || !nextMain || !field || !fieldName || !panel || !sidebar || !nextPanel || !nextSidebar || !nextField ||
      [...incoming.querySelectorAll?.('#can-main') ?? []].length !== 1 ||
      nextPanel.querySelector?.('script') !== null || nextSidebar.querySelector?.('script') !== null ||
      !checkPreferenceForm(form, nextField) ||
      !applyPollResponse(document, main, nextMain.outerHTML, status)) return false;
  return true;
}

function checkPreferenceForm(form: ElementLike, nextField: DomNode): boolean {
  return [...nextField.querySelectorAll?.('form[data-can-preference-form]') ?? []].some(candidate =>
    candidate.getAttribute?.('action') === form.getAttribute('action'));
}

/** A followed native preference POST returns an authorized full page. */
function applyPreferenceResponse(document: DocumentLike, form: ElementLike, body: string, status: number): boolean {
  if (status < 200 || status >= 300 || document.createElement === undefined) return false;
  const template = document.createElement('template') as { innerHTML: string; readonly content: DomNode };
  template.innerHTML = body;
  const incoming = template.content;
  const main = document.getElementById('can-main');
  const nextMain = incoming.querySelector?.('#can-main') as (DomNode & { outerHTML: string }) | null;
  const field = (form as ElementLike & { closest(selector: string): ElementLike | null }).closest('[data-can-preference-field]');
  const fieldName = field?.getAttribute('data-can-preference-field');
  const panel = [...document.querySelectorAll('.can-settings-panel')][0];
  const sidebar = [...document.querySelectorAll('.can-settings-sidebar')][0];
  const nextPanel = incoming.querySelector?.('.can-settings-panel');
  const nextSidebar = incoming.querySelector?.('.can-settings-sidebar');
  const nextField = [...nextPanel?.querySelectorAll?.('[data-can-preference-field]') ?? []]
    .find(candidate => candidate.getAttribute?.('data-can-preference-field') === fieldName);
  if (!checkPreferenceResponse(document, incoming, main, nextMain, form, field, fieldName,
      panel, sidebar, nextPanel, nextSidebar, nextField, status)) return false;
  // Only the settled field adopts server values. Neighboring settings drafts,
  // business inputs and the shell's open Settings checkbox remain in place.
  morphNode(panel as unknown as DomNode, nextPanel!, document, false, undefined, field as unknown as DomNode);
  morphNode(sidebar as unknown as DomNode, nextSidebar!, document);
  return true;
}

/** Enhance canonical native forms without changing their body or owning action. */
function bindPreferenceForm(form: ElementLike, client: BrowserClient, internals: ClientInternals): () => void {
  if (internals.windowRef.FormData === undefined) return () => {};
  const field = (form as ElementLike & { closest(selector: string): ElementLike | null }).closest('[data-can-preference-field]');
  const outlet = field?.querySelector?.('[data-can-preference-error]') as (ElementLike & { textContent: string | null }) | null | undefined;
  const context = client.contextKey();
  let stopped = false;
  let pending = false;
  let inflight: AbortController | null = null;
  let release: (() => void) | undefined;
  const alive = () => !stopped && form.isConnected && client.contextKey() === context;
  const feedback = (message: string, code?: string) => {
    if (!outlet) return;
    outlet.textContent = message;
    if (code) outlet.setAttribute('data-can-preference-error-code', code);
    else outlet.removeAttribute('data-can-preference-error-code');
  };
  const onSubmit = (event: EventLike) => {
    event.preventDefault();
    event.stopPropagation?.();
    const panel = [...internals.document.querySelectorAll('.can-settings-panel')][0];
    if (!alive() || pending || panel?.querySelector?.('form[data-can-preference-form][aria-busy="true"]')) return;
    const action = form.getAttribute('action') ?? '';
    if (!action.startsWith('/') || action.startsWith('//') || action.includes('\\') || action.includes('#')) {
      feedback('The setting could not be saved. Please try again.', 'save_failed'); return;
    }
    const body = new URLSearchParams();
    for (const [name, value] of new internals.windowRef.FormData!(form, event.submitter)) {
      if (typeof value !== 'string') { feedback('The setting could not be saved.', 'save_failed'); return; }
      body.append(name, value);
    }
    internals.onGeneratedFormStart?.();
    pending = true;
    feedback('');
    const busy = form.getAttribute('aria-busy');
    const buttons = [...field?.querySelectorAll?.('button') ?? []].map(button => [button, button.getAttribute('disabled')] as const);
    form.setAttribute('aria-busy', 'true');
    form.setAttribute('data-can-submit-state', 'pending');
    for (const [button] of buttons) button.setAttribute('disabled', '');
    release = () => {
      release = undefined;
      if (busy === null) form.removeAttribute('aria-busy'); else form.setAttribute('aria-busy', busy);
      for (const [button, disabled] of buttons) {
        if (disabled === null) button.removeAttribute('disabled'); else button.setAttribute('disabled', disabled);
      }
    };
    const controller = new AbortController();
    inflight = controller;
    void (async () => {
      try {
        // Native fetch follows the page's existing 303 to an authorized full GET.
        const response = await internals.fetchImpl(action, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', Accept: 'text/html, application/json' },
          body: body.toString(), mode: 'same-origin', signal: controller.signal,
        });
        const html = await response.text();
        if (!alive()) return;
        if (response.status < 200 || response.status >= 300) {
          let message = 'The setting could not be saved. Please try again.';
          let code = 'save_failed';
          try {
            const error: unknown = JSON.parse(html);
            if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') message = error.message;
            if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') code = error.code;
          } catch { /* HTML denials never become markup in a Settings form. */ }
          form.setAttribute('data-can-submit-state', 'denied'); feedback(message, code); return;
        }
        // Settle controls before morphing so server markup cannot inherit a
        // temporary disabled button. Invalidate reads captured before the save.
        release?.();
        client.rescan(true);
        if (!applyPreferenceResponse(internals.document, form, html, response.status)) throw new Error('Invalid preference page response.');
        form.setAttribute('data-can-submit-state', 'committed');
        client.rescan();
      } catch {
        if (alive()) {
          form.setAttribute('data-can-submit-state', 'error');
          feedback('The saved setting could not be confirmed. Reload the page before trying again.', 'save_failed');
        }
      } finally {
        inflight = null;
        pending = false;
        release?.();
      }
    })();
  };
  form.addEventListener('submit', onSubmit);
  return () => {
    stopped = true;
    releaseClientResources([() => release?.(), () => inflight?.abort(), () => form.removeEventListener('submit', onSubmit),
      ...(pending ? [() => form.removeAttribute('data-can-submit-state')] : [])]);
  };
}

function bindPreferenceCancel(control: ElementLike, _client: BrowserClient, internals: ClientInternals): () => void {
  const onClick = () => {
    const panel = [...internals.document.querySelectorAll('.can-settings-panel')][0];
    if (panel?.querySelector?.('form[data-can-preference-form][aria-busy="true"]')) return;
    for (const form of panel?.querySelectorAll?.('form[data-can-preference-form="save"]') ?? []) {
      (form as ElementLike & { reset(): void }).reset();
      form.removeAttribute('data-can-submit-state');
    }
    for (const outlet of panel?.querySelectorAll?.('[data-can-preference-error]') ?? []) {
      (outlet as ElementLike & { textContent: string | null }).textContent = '';
      outlet.removeAttribute('data-can-preference-error-code');
    }
    const toggle = internals.document.getElementById('can-settings') as (ElementLike & { checked: boolean }) | null;
    if (toggle) toggle.checked = false;
  };
  control.addEventListener('click', onClick);
  return () => control.removeEventListener('click', onClick);
}

function bindOnceAction(control: ElementLike): () => void {
  let inflight = false;
  const onClick = (): void => {
    if (inflight) {
      return;
    }
    inflight = true;
    control.setAttribute("disabled", "");
    control.setAttribute("aria-disabled", "true");
  };
  const release = (): void => {
    inflight = false;
    control.removeAttribute("disabled");
    control.removeAttribute("aria-disabled");
  };
  control.addEventListener("click", onClick);
  // Explicit settlement releases the armed control. A detached swap owns
  // its replacement state; a still-connected disposal releases our state.
  const onSettled = (): void => {
    release();
  };
  control.addEventListener("can:settled", onSettled);
  return () => {
    const releaseState = inflight && control.isConnected;
    inflight = false;
    releaseClientResources([
      ...(releaseState ? [
        () => control.removeAttribute("disabled"),
        () => control.removeAttribute("aria-disabled"),
      ] : []),
      () => control.removeEventListener("click", onClick),
      () => control.removeEventListener("can:settled", onSettled),
    ]);
  };
}

function focusMain(document: DocumentLike): void {
  const main = document.getElementById("can-main");
  if (main === null) {
    return;
  }
  const heading = main.querySelector?.("h1, h2, [data-can-focus]") ?? null;
  (heading ?? main).focus();
}

function focusTargetDialog(document: DocumentLike, hash: string): void {
  if (!hash.startsWith("#") || hash.length < 2) {
    return;
  }
  const target = document.getElementById(hash.slice(1));
  if (target !== null && target.tagName.toLowerCase() === "dialog") {
    target.focus();
  }
}

function closeOpenDetails(document: DocumentLike): void {
  for (const details of document.querySelectorAll("details[open]")) {
    details.removeAttribute("open");
  }
}

/** Native dialog owns modal focus; the checkbox remains the drawer trigger. */
const bindSplitCollection: ComponentBinder = (root, _client, internals) => {
  type Toggle = ElementLike & { checked?: boolean; getClientRects?: () => { readonly length: number } };
  type Dialog = ElementLike & { readonly open?: boolean; matches?: (selector: string) => boolean;
    show?: () => void; showModal?: () => void; close?: () => void };
  const toggle = (): Toggle | null => root.querySelector?.('.drawer-toggle') ?? null;
  const dialog = (): Dialog | null => root.querySelector?.('dialog[data-can-split-panel]') ?? null;
  const mobile = (): boolean => (toggle()?.getClientRects?.().length ?? 0) > 0;
  let stopped = false;
  let mobileOpened = false;
  // Native dialog methods run on their receiver: the capability guard in
  // sync() admits them, and each call below keeps its pane receiver.
  const syncSplitPane = (
    checkbox: Toggle,
    pane: Dialog,
  ): void => {
    const modal = pane.matches?.(':modal') === true;
    if (mobile() && checkbox.checked === true) {
      if (modal) return;
      if (pane.open) pane.close!();
      pane.setAttribute('closedby', 'any');
      pane.setAttribute('style', 'max-width:90vw;margin:0;position:fixed;inset:0 0 0 auto;min-height:100vh;visibility:visible;transform:none');
      for (const other of internals.document.querySelectorAll('[data-can-split] dialog:modal')) {
        if (other !== pane) (other as Dialog).close?.();
      }
      pane.showModal!();
      mobileOpened = true;
    } else {
      if (modal || (mobile() && pane.open)) pane.close!();
      pane.setAttribute('closedby', 'none');
      pane.setAttribute('style', 'max-width:90vw;margin:0;position:relative;visibility:visible;transform:none');
      if (!mobile()) mobileOpened = false;
      if (!mobile() && !pane.open) pane.show!();
    }
  };
  const sync = (): void => {
    const checkbox = toggle(), pane = dialog();
    if (stopped || !root.isConnected || checkbox === null || pane === null ||
        pane.show === undefined || pane.showModal === undefined || pane.close === undefined) return;
    syncSplitPane(checkbox, pane);
  };
  const close = (): void => {
    const checkbox = toggle(), pane = dialog();
    if (checkbox !== null) checkbox.checked = false;
    if (pane?.open) pane.close?.();
  };
  const closed = (): void => {
    const pane = dialog(), checkbox = toggle();
    // close() queues its event: a subsequent showModal()/show() owns new state.
    if (stopped || pane?.open || checkbox === null) return;
    checkbox.checked = false;
    if (mobileOpened && mobile() && checkbox.isConnected) checkbox.focus();
    mobileOpened = false;
  };
  const clicked = (event: EventLike): void => {
    if (event.target?.hasAttribute('data-can-split-close')) close();
  };
  const releases: Array<() => void> = [];
  const acquiredToggle = toggle();
  const pane = dialog();
  // Disposal owns only acquired nodes. A retained root may already contain
  // the replacement request's selected pane when the old binder releases.
  const dispose = (): void => {
    const owned = (node: ElementLike): boolean => {
      const owner = (node as ElementLike & { closest?: (selector: string) => ElementLike | null }).closest?.('[data-can-split]');
      // Reconciliation may transfer these nodes into a new connected owner
      // before releasing this root. Its new binder owns their live state.
      return !node.isConnected || owner == null || owner === root;
    };
    if (acquiredToggle !== null && owned(acquiredToggle)) acquiredToggle.checked = false;
    if (pane?.open && owned(pane)) pane.close?.();
  };
  try {
    releases.push(() => root.removeEventListener('change', sync));
    root.addEventListener('change', sync);
    releases.push(() => root.removeEventListener('click', clicked));
    root.addEventListener('click', clicked);
    releases.push(() => internals.windowRef.removeEventListener('resize', sync));
    internals.windowRef.addEventListener('resize', sync);
    if (pane !== null) {
      releases.push(() => pane.removeEventListener('close', closed));
      pane.addEventListener('close', closed);
    }
    sync();
  } catch (error) {
    stopped = true;
    try { releaseClientResources([...releases, dispose]); } catch { /* Preserve acquisition failure. */ }
    throw error;
  }
  return () => {
    stopped = true;
    releaseClientResources([...releases.splice(0), dispose]);
  };
};

/** Native popover owns keyboard/light dismissal; this binder owns viewport placement. */
const bindActionMenu: ComponentBinder = (root, _client, internals) => {
  type Box = ElementLike & { getBoundingClientRect?: () => { left: number; right: number; top: number; bottom: number; width: number; height: number }; style?: { left: string; top: string; maxHeight: string }; matches?: (selector: string) => boolean };
  const trigger = root.querySelector?.('[data-can-action-menu-trigger]') as Box | null;
  const panel = root.querySelector?.('[data-can-action-menu-popover]') as Box | null;
  const window = internals.windowRef as WindowLike & { innerWidth?: number; innerHeight?: number };
  const place = () => {
    if (!trigger?.getBoundingClientRect || !panel?.getBoundingClientRect || !panel.style) return;
    const anchor = trigger.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
    const width = window.innerWidth ?? 1024, height = window.innerHeight ?? 768;
    const below = height - anchor.bottom - 8, above = anchor.top - 8;
    const goesBelow = bounds.height <= below || below >= above;
    panel.style.maxHeight = `${Math.max(0, goesBelow ? below : above)}px`;
    panel.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, width - bounds.width - 8))}px`;
    panel.style.top = `${Math.max(8, goesBelow ? anchor.bottom : anchor.top - Math.min(bounds.height, above))}px`;
  };
  const resized = () => { if (panel?.matches?.(':popover-open')) place(); };
  panel?.addEventListener('toggle', place);
  window.addEventListener('resize', resized);
  window.addEventListener('scroll', resized);
  return () => {
    panel?.removeEventListener('toggle', place);
    window.removeEventListener('resize', resized);
    window.removeEventListener('scroll', resized);
  };
};

/** Compact controls open the existing canonical form in a modal dialog. */
const bindMenuDialog: ComponentBinder = (root, _client, internals) => {
  type Native = ElementLike & { open?: boolean; showModal?: () => void; close?: () => void; hidePopover?: () => void; closest?: (selector: string) => Native | null };
  const opener = root.querySelector?.('[data-can-menu-dialog-open]') as Native | null;
  const dialog = root.querySelector?.('dialog') as Native | null;
  const cancel = root.querySelector?.('[data-can-menu-dialog-close]');
  let returnTo: ElementLike | null = opener;
  let stopped = false;
  const open = () => {
    if (!dialog?.showModal || dialog.open) return;
    const menu = opener?.closest?.('[data-can-action-menu]');
    returnTo = menu?.querySelector?.('[data-can-action-menu-trigger]') ?? opener;
    const panel = opener?.closest?.('[popover]');
    panel?.hidePopover?.();
    dialog.showModal();
  };
  const close = () => { if (dialog?.open) dialog.close?.(); };
  const closed = () => { if (!stopped && returnTo?.isConnected) returnTo.focus(); };
  opener?.addEventListener('click', open);
  cancel?.addEventListener('click', close);
  dialog?.addEventListener('close', closed);
  return () => {
    stopped = true;
    opener?.removeEventListener('click', open);
    cancel?.removeEventListener('click', close);
    dialog?.removeEventListener('close', closed);
    close();
  };
};

/** Checked local panel targets add activation only, never routes or authority. */
const bindPanel: ComponentBinder = (root, _client, internals) => {
  type Native = ElementLike & { checked?: boolean; open?: boolean; showModal?: () => void; close?: () => void;
    closest?: (selector: string) => Native | null; hidePopover?: () => void };
  const modal = root.getAttribute('data-can-panel') === 'modal';
  const pane = (modal ? root : root.querySelector?.('aside') ?? null) as Native | null;
  const target = (modal ? root : root.querySelector?.('input.drawer-toggle') ?? null) as Native | null;
  let returnTo: ElementLike | null = null;
  let active = false;
  let stopped = false;
  const restore = () => {
    if (!active) return;
    active = false;
    if (!stopped && returnTo?.isConnected) returnTo.focus();
  };
  const close = () => {
    if (modal) { if (pane?.open) pane.close?.(); }
    else if (target !== null) { target.checked = false; restore(); }
  };
  const openPanel = (event: EventLike, opener: Native): void => {
    if (modal && pane?.showModal === undefined) return;
    event.preventDefault();
    if (active) return;
    const menu = opener.closest?.('[data-can-action-menu]');
    returnTo = menu?.querySelector?.('[data-can-action-menu-trigger]') ?? opener;
    opener.closest?.('[popover]')?.hidePopover?.();
    active = true;
    if (modal) pane?.showModal?.();
    else if (target !== null) { target.checked = true; pane?.focus(); }
  };
  const clicked = (event: EventLike) => {
    const origin = event.target as Native | null;
    const opener = origin?.closest?.('[data-can-panel-open]');
    const id = target?.getAttribute('id');
    if (opener !== null && opener !== undefined && id && opener.getAttribute('data-can-panel-open') === id &&
        internals.document.getElementById(id) === target) {
      openPanel(event, opener);
      return;
    }
    const control = origin?.closest?.('[data-can-panel-close]');
    if (control?.closest?.('[data-can-panel]') === root) {
      event.preventDefault();
      close();
    }
  };
  const changed = () => {
    if (!modal && target?.checked === false) restore();
  };
  const escaped = (event: EventLike) => {
    if (!modal && active && (event as EventLike & { key?: string }).key === 'Escape' &&
        (internals.document.activeElement as Native | null)?.closest?.('[data-can-panel]') === root) {
      event.preventDefault(); close();
    }
  };
  internals.windowRef.addEventListener('click', clicked);
  internals.windowRef.addEventListener('keydown', escaped);
  target?.addEventListener('change', changed);
  if (modal) pane?.addEventListener('close', restore);
  return () => {
    stopped = true;
    releaseClientResources([
      () => internals.windowRef.removeEventListener('click', clicked),
      () => internals.windowRef.removeEventListener('keydown', escaped),
      () => target?.removeEventListener('change', changed),
      () => { if (modal) pane?.removeEventListener('close', restore); },
      close,
    ]);
  };
};

// Core binder seeds (catalog ids bound by this slice).
registerBinder("poll-region", bindPollRegion);
registerBinder("guarded-form", bindGuardedForm);
registerBinder("generated-form", bindGeneratedForm);
registerBinder("preference-form", bindPreferenceForm);
registerBinder("preference-cancel", bindPreferenceCancel);
registerBinder("once-action", (root) => bindOnceAction(root));
registerBinder("split-collection", bindSplitCollection);
registerBinder("gallery", bindGallery);
registerBinder("action-menu", bindActionMenu);
registerBinder("menu-dialog", bindMenuDialog);
registerBinder("panel", bindPanel);
registerBinder("generated-view", (root) => bindGeneratedView(root));

/** Scan hooks: selector per core binder id. */
const BINDER_SELECTORS: ReadonlyArray<readonly [string, string]> = [
  ["poll-region", "[data-can-poll]"],
  ["guarded-form", "form[data-can-guard]"],
  ["generated-form", "form[data-can-generated-form], form[data-can-delete-form]"],
  ["preference-form", "form[data-can-preference-form]"],
  ["preference-cancel", "[data-can-preference-cancel]"],
  ["once-action", "[data-can-once]"],
  ["split-collection", "[data-can-split]"],
  ["gallery", "[data-can-gallery]"],
  ["generated-view", "[data-can-view]"],
  ["action-menu", "[data-can-action-menu]"],
  ["menu-dialog", "[data-can-menu-dialog]"],
  ["panel", "[data-can-panel]"],
];

/** Live clients by document: starting twice returns the same client. */
const LIVE_CLIENTS = new WeakMap<object, BrowserClient>();

function dropPollBindings(bound: BoundRegion[]): void {
  for (let index = bound.length - 1; index >= 0; index -= 1) {
    const entry = bound[index];
    if (entry?.binder === 'poll-region') { bound.splice(index, 1); entry.stop(); }
  }
}

function elementSignature(client: BrowserClient, element: ElementLike): string {
  return `${client.contextKey()}|${element.getAttribute('data-can-poll-url') ?? ''}|${element.getAttribute('data-can-poll-interval') ?? ''}|${element.getAttribute('data-can-poll-context') ?? ''}|${element.getAttribute('data-can-generated-form') ?? ''}|${element.getAttribute('data-can-delete-form') ?? ''}|${element.getAttribute('action') ?? ''}|${element.getAttribute('data-can-view') ?? ''}`;
}

function releaseOldBinding(bound: BoundRegion[], old: BoundRegion, oldIndex: number, element: ElementLike, id: string): void {
  // Releasing a split binder closes its native modal. Preserve the
  // current request's selected checkbox for the replacement binder;
  // cleanup must not erase a selection delivered by the new read.
  const toggle = id === 'split-collection'
    ? element.querySelector?.('.drawer-toggle') as (ElementLike & { checked?: boolean }) | null | undefined : null;
  const selected = toggle?.checked;
  bound.splice(oldIndex, 1); old.stop();
  if (toggle?.isConnected && selected !== undefined && element.querySelector?.('.drawer-toggle') === toggle) {
    toggle.checked = selected;
  }
}

function rebindElement(
  bound: BoundRegion[],
  element: ElementLike,
  id: string,
  binder: ComponentBinder,
  client: BrowserClient,
  internals: ClientInternals,
): void {
  const signature = elementSignature(client, element);
  const oldIndex = bound.findIndex((entry) => entry.element === element && entry.binder === id);
  const old = bound[oldIndex];
  const changedMount = id === 'generated-view' &&
    GENERATED_VIEW_MOUNTS.get(generatedViewPresentationOf(element).view) !== generatedViewMountBindings.get(element);
  if (old !== undefined && old.signature === signature &&
      !(id === 'generated-view' && (generatedViewRebinds.has(element) || changedMount))) return;
  if (old !== undefined) {
    releaseOldBinding(bound, old, oldIndex, element, id);
  }
  bound.push({ element, binder: id, signature, stop: binder(element, client, internals) });
}

function bindingFormStale(entry: BoundRegion): boolean {
  return (entry.binder === 'poll-region' && !entry.element.hasAttribute('data-can-poll')) ||
    (entry.binder === 'guarded-form' && !entry.element.hasAttribute('data-can-guard')) ||
    (entry.binder === 'once-action' && !entry.element.hasAttribute('data-can-once')) ||
    (entry.binder === 'generated-form' && !entry.element.hasAttribute('data-can-generated-form') && !entry.element.hasAttribute('data-can-delete-form')) ||
    (entry.binder === 'preference-form' && !entry.element.hasAttribute('data-can-preference-form')) ||
    (entry.binder === 'preference-cancel' && !entry.element.hasAttribute('data-can-preference-cancel'));
}

function bindingChromeStale(entry: BoundRegion): boolean {
  return (entry.binder === 'split-collection' && !entry.element.hasAttribute('data-can-split')) ||
    (entry.binder === 'gallery' && !entry.element.hasAttribute('data-can-gallery')) ||
    (entry.binder === 'action-menu' && !entry.element.hasAttribute('data-can-action-menu')) ||
    (entry.binder === 'menu-dialog' && !entry.element.hasAttribute('data-can-menu-dialog')) ||
    (entry.binder === 'panel' && !entry.element.hasAttribute('data-can-panel')) ||
    (entry.binder === 'generated-view' && !entry.element.hasAttribute('data-can-view'));
}

function bindingStale(entry: BoundRegion): boolean {
  return !entry.element.isConnected || bindingFormStale(entry) || bindingChromeStale(entry);
}

function releaseStaleBindings(bound: BoundRegion[]): void {
  // Release bindings whose elements left the document (swap
  // replacement owns the new state; stale bindings never linger).
  for (let index = bound.length - 1; index >= 0; index -= 1) {
    const entry = bound[index];
    if (entry !== undefined && bindingStale(entry)) {
      bound.splice(index, 1);
      entry.stop();
    }
  }
}

/** Release each owned client resource, then report the first failure verbatim. */
function releaseClientResources(releases: readonly (() => void)[]): void {
  let failure: { value: unknown } | undefined;
  for (const release of releases) {
    try { release(); }
    catch (value) { failure ??= { value }; }
  }
  if (failure !== undefined) throw failure.value;
}

/**
 * Start the browser client against an explicit document/window/fetch.
 * Idempotent per document: starting twice (e.g. a twice-executed
 * script tag) returns the same live client instead of double-binding.
 * A stopped client is terminal: start again for a fresh client.
 * Confirmed generated-form commits refresh the current main partial.
 * Other reads belong to armed polls.
 */
export function startBrowserClient(options: BrowserClientOptions): BrowserClient {
  const document = options.window.document;
  const live = LIVE_CLIENTS.get(document as object);
  if (live !== undefined) {
    return live;
  }
  let repeatOwner: { context: string; stop: () => void } | null = null;
  const clearRepeatOwner = () => { const owner = repeatOwner; repeatOwner = null; owner?.stop(); };
  let refresh: AbortController | null = null;
  const cancelRefresh = () => { refresh?.abort(); refresh = null; };
  const refreshCommittedPage = (form: ElementLike, result: GeneratedSubmitResult, automatic = false): void => {
    if (result.kind !== 'committed') return;
    const region = document.getElementById('can-main');
    const location = options.window.location;
    const path = location.pathname;
    if (region === null || (region as unknown as DomNode).contains?.(form) !== true ||
        path === undefined || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return;
    cancelRefresh();
    const controller = new AbortController();
    refresh = controller;
    const context = client.contextKey();
    const preserveForm = automatic || (result.result.refresh !== undefined &&
      region.getAttribute('data-can-refresh') === (form.querySelector?.('input[name="operation"]') as (ElementLike & { value: string }) | null)?.value);
    const current = () => !stopped && refresh === controller && !controller.signal.aborted &&
      region.isConnected && document.getElementById('can-main') === region && client.contextKey() === context &&
      !region.hasAttribute('data-can-read-denied') &&
      document.body?.getAttribute('data-can-logged-out') !== 'true' && region.getAttribute('data-can-logged-out') !== 'true';
    // Existing poll reads must not paint a state captured before this commit.
    client.rescan(true);
    void (async () => {
      try {
        const response = await options.fetchImpl(path + (location.search ?? ''), {
          method: 'GET', headers: { 'HX-Request': 'true', Accept: 'text/html' }, signal: controller.signal,
          mode: 'same-origin', redirect: 'error',
        });
        if (!current()) return;
        const body = response.status === 403 ? '' : await response.text();
        if (!current()) return;
        client.rescan(true);
        if (applyPollResponse(document, region, body, response.status, preserveForm ? undefined : form)) client.rescan();
        else if (response.status === 403) client.rescan(true);
      } catch {
        if (current()) markReadFailure(document, region);
      }
      finally { if (refresh === controller) refresh = null; }
    })();
  };
  const internals: ClientInternals = {
    fetchImpl: options.fetchImpl,
    ...(options.imageFetch === undefined ? {} : { imageFetch: options.imageFetch }),
    windowRef: options.window,
    document,
    visibility: options.visibility ?? document,
    onGeneratedFormResult: (form, result, automatic) => {
      refreshCommittedPage(form, result, automatic);
      if (result.kind !== 'committed') client.rescan();
      options.onGeneratedFormResult?.(form, result);
    },
    onGeneratedFormStart: () => { cancelRefresh(); dropPollBindings(bound); },
    claimRefresh: (stop) => { clearRepeatOwner(); repeatOwner = { context: client.contextKey(), stop }; },
    onGeneratedFormError: (form, error) => { client.rescan(); options.onGeneratedFormError?.(form, error); },
    ...(options.deliverPollResponse === undefined
      ? {}
      : { deliver: options.deliverPollResponse }),
  };
  const bound: BoundRegion[] = [];
  const releaseListeners: Array<() => void> = [];
  let stopped = false;
  let releaseSwapHook: (() => void) | null = null;

  const hashListener = (_event: EventLike): void => {
    focusTargetDialog(document, options.window.location.hash);
  };
  const keyListener = (event: EventLike): void => {
    const key = (event as EventLike & { key?: unknown }).key;
    if (key === "Escape") {
      closeOpenDetails(document);
    }
  };

  const client: BrowserClient = {
    contextKey: () => {
      const pageKey = document.getElementById("can-main")?.getAttribute("data-can-context") ?? '';
      const ownerKey = document.body?.getAttribute("data-can-context") ?? '';
      const location = options.window.location;
      return `${ownerKey}|${pageKey}|${location.pathname ?? ''}${location.search ?? ''}`;
    },
    rescan: (restartPolling = false) => {
      if (stopped) {
        return;
      }
      if ((options.visibility ?? document).visibilityState !== 'visible' || repeatOwner?.context !== client.contextKey() ||
          document.body?.getAttribute('data-can-logged-out') === 'true' ||
          document.getElementById('can-main')?.getAttribute('data-can-logged-out') === 'true') clearRepeatOwner();
      if (restartPolling) {
        dropPollBindings(bound);
      }
      const snapshot = new Map(BINDERS);
      for (const [id, selector] of BINDER_SELECTORS) {
        const binder = snapshot.get(id);
        if (binder === undefined) {
          continue;
        }
        for (const element of document.querySelectorAll(selector)) {
          rebindElement(bound, element, id, binder, client, internals);
        }
      }
      releaseStaleBindings(bound);
    },
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearRepeatOwner();
      cancelRefresh();
      if (LIVE_CLIENTS.get(document as object) === client) LIVE_CLIENTS.delete(document as object);
      const swapHook = releaseSwapHook;
      releaseSwapHook = null;
      releaseClientResources([
        ...(swapHook === null ? [] : [swapHook]),
        ...releaseListeners.splice(0),
        ...bound.splice(0).map(entry => () => entry.stop()),
      ]);
    },
  };

  try {
    releaseListeners.push(() => options.window.removeEventListener("hashchange", hashListener));
    options.window.addEventListener("hashchange", hashListener);
    releaseListeners.push(() => options.window.removeEventListener("keydown", keyListener));
    options.window.addEventListener("keydown", keyListener);

    if (options.onHtmxSwap !== undefined) {
      releaseSwapHook = options.onHtmxSwap(() => {
        client.rescan();
        focusMain(document);
      });
    }

    LIVE_CLIENTS.set(document as object, client);
    client.rescan();
    return client;
  } catch (error) {
    try { client.stop(); } catch { /* The acquisition failure remains operative. */ }
    throw error;
  }
}

/** Browser globals are adapted here; importing this module on the server has no effects. */
interface NativeWindow {
  readonly innerWidth?: number;
  readonly innerHeight?: number;
  readonly document: DocumentLike & {
    readonly visibilityState: string;
    readonly readyState?: string;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
  };
  readonly location: WindowLike['location'];
  readonly FormData?: FormDataConstructor;
  addEventListener(type: string, listener: (event: EventLike) => void): void;
  removeEventListener(type: string, listener: (event: EventLike) => void): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  fetch(url: string, init: (SubmitFetchInit & { readonly credentials: string; readonly cache: string }) | ImageFetchInit): Promise<{
    readonly status: number; readonly redirected?: boolean;
    readonly headers: { get(name: string): string | null }; text(): Promise<string>; blob?(): Promise<Blob>;
  }>;
  readonly MutationObserver?: new (callback: () => void) => {
    observe(target: unknown, options: unknown): void; disconnect(): void;
  };
}

const NATIVE_CLIENTS = new WeakMap<object, BrowserClient>();

/** Start the installed module against the real browser, including swap/navigation re-scans. */
export function startNativeBrowserClient(native: NativeWindow): BrowserClient {
  const existing = NATIVE_CLIENTS.get(native.document as object);
  if (existing !== undefined) return existing;
  let suspended = false;
  const windowRef: WindowLike = {
    document: native.document, location: native.location,
    get innerWidth() { return native.innerWidth ?? 1024; },
    get innerHeight() { return native.innerHeight ?? 768; },
    addEventListener: (type, listener) => native.addEventListener(type, listener),
    removeEventListener: (type, listener) => native.removeEventListener(type, listener),
    setTimeout: (callback, ms) => native.setTimeout(callback, ms),
    clearTimeout: (handle) => native.clearTimeout(handle),
    ...(native.FormData === undefined ? {} : { FormData: native.FormData }),
  };
  const client = startBrowserClient({
    window: windowRef,
    visibility: { get visibilityState() { return suspended ? "hidden" : native.document.visibilityState; } },
    fetchImpl: async (url, init) => {
      const response = await native.fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store' });
      const nativePreferencePost = init.method === 'POST' && init.redirect === undefined &&
        init.headers['content-type'] === 'application/x-www-form-urlencoded';
      return { status: response.redirected === true && !nativePreferencePost ? 409 : response.status, headers: response.headers, text: () => response.text() };
    },
    imageFetch: async (url, init) => {
      const response = await native.fetch(url, init);
      if (typeof response.blob !== 'function') throw new Error('Gallery preview blob transport is unavailable.');
      return { status: response.status, ...(response.redirected === undefined ? {} : { redirected: response.redirected }),
        headers: response.headers, blob: () => response.blob!() };
    },
    onHtmxSwap: (rescan) => {
      const listener = () => rescan();
      const release = () => native.document.removeEventListener('htmx:afterSwap', listener);
      try {
        native.document.addEventListener('htmx:afterSwap', listener);
      } catch (error) {
        try { release(); } catch { /* The acquisition failure remains operative. */ }
        throw error;
      }
      return release;
    },
  });
  let observer: InstanceType<NonNullable<NativeWindow['MutationObserver']>> | null = null;
  const releaseListeners: Array<() => void> = [];
  let releaseVisibility: (() => void) | null = null;
  const navigate = () => client.rescan();
  const visible = () => client.rescan(true);
  let stopped = false;
  const unload = () => {
    if (stopped) return;
    stopped = true;
    if (NATIVE_CLIENTS.get(native.document as object) === handle) NATIVE_CLIENTS.delete(native.document as object);
    const ownedObserver = observer;
    observer = null;
    const visibilityListener = releaseVisibility;
    releaseVisibility = null;
    releaseClientResources([
      ...(ownedObserver === null ? [] : [() => ownedObserver.disconnect()]),
      ...releaseListeners.splice(0),
      ...(visibilityListener === null ? [] : [visibilityListener]),
      () => client.stop(),
    ]);
  };
  const pageHide = (event: EventLike) => {
    if (event.persisted === true) { suspended = true; client.rescan(true); } else unload();
  };
  const pageShow = (event: EventLike) => {
    if (event.persisted === true && !stopped) { suspended = false; client.rescan(true); }
  };
  const handle: BrowserClient = { contextKey: () => client.contextKey(), rescan: (restart) => client.rescan(restart), stop: unload };
  try {
    observer = native.MutationObserver === undefined ? null : new native.MutationObserver(() => client.rescan());
    if (native.document.body !== null) observer?.observe(native.document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-can-context', 'data-can-poll', 'data-can-poll-context', 'data-can-refresh', 'data-can-logged-out'],
    });
    releaseListeners.push(() => native.removeEventListener('popstate', navigate));
    native.addEventListener('popstate', navigate);
    releaseVisibility = () => native.document.removeEventListener('visibilitychange', visible);
    native.document.addEventListener('visibilitychange', visible);
    releaseListeners.push(() => native.removeEventListener('pagehide', pageHide));
    native.addEventListener('pagehide', pageHide);
    releaseListeners.push(() => native.removeEventListener('pageshow', pageShow));
    native.addEventListener('pageshow', pageShow);
    NATIVE_CLIENTS.set(native.document as object, handle);
    return handle;
  } catch (error) {
    try { unload(); } catch { /* The acquisition failure remains operative. */ }
    throw error;
  }
}

const browser = (globalThis as unknown as { readonly window?: NativeWindow }).window;
if (browser?.document !== undefined && typeof browser.fetch === 'function') {
  if (browser.document.readyState === 'loading') {
    browser.document.addEventListener('DOMContentLoaded', () => { startNativeBrowserClient(browser); });
  } else startNativeBrowserClient(browser);
}
