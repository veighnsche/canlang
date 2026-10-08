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
 *   controls stay in place. Hooks let the host handle committed results.
 * - Obsolete actions: `[data-can-once]` controls disable while their
 *   request is in flight (re-enabled on completion/failure), so a
 *   repeated activation can never double-submit a mutation.
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
import { PollRegion, submitFetchPollFetch } from "./polling.js";
import type { VisibilityLike } from "./polling.js";
import { GeneratedSubmitError, submitGeneratedForm } from "../client.js";
import type { DomControlLike, GeneratedSubmitResult, SubmitFetch, SubmitFetchInit } from "../client.js";
import type { DerivedOperationInputs, FormMode } from "@canlang/contracts";

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
  readonly document: DocumentLike;
  readonly location: { readonly hash: string; readonly pathname?: string; readonly search?: string };
  addEventListener(type: string, listener: (event: EventLike) => void): void;
  removeEventListener(type: string, listener: (event: EventLike) => void): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  readonly FormData?: FormDataConstructor;
}

/** Client internals shared with binders (fetch, window, poll delivery). */
export interface ClientInternals {
  readonly fetchImpl: SubmitFetch;
  readonly windowRef: WindowLike;
  readonly deliver?: BrowserClientOptions["deliverPollResponse"];
  readonly document: DocumentLike;
  readonly visibility: VisibilityLike;
  readonly onGeneratedFormResult?: BrowserClientOptions["onGeneratedFormResult"];
  readonly onGeneratedFormError?: BrowserClientOptions["onGeneratedFormError"];
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

export interface BrowserClientOptions {
  readonly window: WindowLike;
  readonly fetchImpl: SubmitFetch;
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
  /** The host can observe outcomes; source error feedback retains the form DOM. */
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
  nodeValue: string | null;
  readonly childNodes: ArrayLike<DomNode>;
  readonly tagName?: string;
  readonly attributes?: Iterable<{ readonly name: string; readonly value: string }>;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
  querySelector?(selector: string): DomNode | null;
  querySelectorAll?(selector: string): Iterable<DomNode>;
  contains?(other: unknown): boolean;
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

function formIdentity(node: DomNode): string {
  const id = node.getAttribute?.('id') ?? '';
  const fields = [...node.querySelectorAll?.('input[type="hidden"]') ?? []];
  const field = (name: string) => fields.find((input) => input.getAttribute?.('name') === name)?.getAttribute?.('value') ?? '';
  const refs = fields.filter((input) => input.getAttribute?.('name') !== 'operation_id' && /(?:\[id\]|_id)$/.test(input.getAttribute?.('name') ?? ''))
    .map((input) => [input.getAttribute?.('name'), input.getAttribute?.('value')]).sort();
  const handle = refs.length === 0 && id === '' ? field('action_handle') : '';
  return JSON.stringify([id, node.getAttribute?.('action'), field('operation'), refs, handle]);
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

function morphNode(current: DomNode, next: DomNode, document: DocumentLike): void {
  if (current.nodeType !== 1) { current.nodeValue = next.nodeValue; return; }
  const tag = current.tagName?.toLowerCase();
  const editable = (tag === 'input' && current.getAttribute?.('type') !== 'hidden') || tag === 'textarea' || tag === 'select';
  const keepInput = editable && (document.activeElement === current as unknown as ElementLike ||
    (current.files?.length ?? 0) > 0 ||
    (current.defaultValue !== undefined && current.value !== current.defaultValue) ||
    (current.defaultChecked !== undefined && current.checked !== current.defaultChecked) ||
    [...current.querySelectorAll?.('option') ?? []].some((option) => option.selected !== option.defaultSelected));
  const value = current.value;
  const checked = current.checked;
  const selected = tag === 'select'
    ? [...(keepInput ? current : next).querySelectorAll?.('option') ?? []].filter((option) => option.selected).map((option) => option.value) : null;
  const attributes = new Map([...next.attributes ?? []].map((attribute) => [attribute.name, attribute.value]));
  for (const attribute of [...current.attributes ?? []]) {
    if (!attributes.has(attribute.name)) current.removeAttribute?.(attribute.name);
  }
  for (const [name, value] of attributes) current.setAttribute?.(name, value);
  const desired = Array.from(next.childNodes);
  for (const [index, child] of desired.entries()) {
    const anchor = current.childNodes[index] ?? null;
    let matched: DomNode | null = null;
    const id = child.getAttribute?.('id');
    if (id !== undefined && id !== null) {
      matched = Array.from(current.childNodes).find((node) => compatibleNode(node, child)) ?? null;
    } else if (anchor !== null && compatibleNode(anchor, child)) matched = anchor;
    if (matched === null) current.insertBefore(child.cloneNode(true), anchor);
    else {
      if (matched !== anchor) current.insertBefore(matched, anchor);
      morphNode(matched, child, document);
    }
  }
  while (current.childNodes.length > desired.length) {
    const last = current.childNodes[current.childNodes.length - 1];
    if (last !== undefined) current.removeChild(last);
  }
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    if (tag !== 'select' && current.getAttribute?.('type') !== 'file' && value !== undefined) current.value = keepInput ? value : next.value ?? '';
    if (checked !== undefined) current.checked = keepInput ? checked : next.checked ?? false;
    if (selected !== null) {
      for (const option of current.querySelectorAll?.('option') ?? []) option.selected = selected.includes(option.value);
    }
  }
}

/** Accept one same-context main partial; never paint login/full-document/error HTML. */
export function applyPollResponse(document: DocumentLike, region: ElementLike, body: string, status: number): boolean {
  if (status < 200 || status >= 300 || /<!doctype|<\/?(?:html|head|body)(?:\s|>)/i.test(body) || document.createElement === undefined) return false;
  const template = document.createElement('template') as { innerHTML: string; readonly content: DomNode };
  template.innerHTML = body;
  const significant = Array.from(template.content.childNodes).filter((node) => node.nodeType === 1 || (node.nodeValue ?? '').trim() !== '');
  const incoming = significant[0];
  if (significant.length !== 1 || incoming?.tagName?.toLowerCase() !== 'main' || incoming.getAttribute?.('id') !== region.getAttribute('id') ||
      incoming.getAttribute?.('data-can-context') !== region.getAttribute('data-can-context') ||
      incoming.getAttribute?.('data-can-poll-context') !== region.getAttribute('data-can-poll-context') || incoming.querySelector?.('script') !== null) return false;
  morphNode(region as unknown as DomNode, incoming, document);
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
      const applied = internals.deliver === undefined
        ? applyPollResponse(internals.document, region, body, status)
        : internals.deliver(region, body, status);
      if (applied !== false) client.rescan();
      return applied;
    },
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
  const onSubmit = (event: EventLike): void => {
    event.preventDefault();
    event.stopPropagation?.();
    if (pending || !alive()) return;
    feedback(null, '');
    pending = true;
    previousBusy = form.getAttribute('aria-busy');
    form.setAttribute('aria-busy', 'true');
    form.setAttribute('data-can-submit-state', 'pending');
    void (async () => {
      try {
        const metadata = JSON.parse(form.getAttribute('data-can-generated-form') ?? '') as {
          derived?: DerivedOperationInputs; mode?: FormMode; renderedInputs?: readonly string[];
        } | null;
        if (metadata?.derived === undefined || typeof metadata.derived.operation !== 'string' ||
            !Array.isArray(metadata.derived.inputs) ||
            !['create', 'update', 'scenario'].includes(metadata.mode ?? '') ||
            (metadata.renderedInputs !== undefined && (!Array.isArray(metadata.renderedInputs) ||
              metadata.renderedInputs.some(name => typeof name !== 'string')))) {
          throw new GeneratedSubmitError('usage', 'Form submit metadata is unavailable.', false);
        }
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
        const result = await submitGeneratedForm({
          derived: metadata.derived, mode: metadata.mode!, flat,
          ...(metadata.renderedInputs === undefined ? {} : { renderedInputs: metadata.renderedInputs }),
          action: form.getAttribute('action') ?? '', fragment: false, denialFormat: 'json',
          fetchImpl: (url, init) => {
            if (!alive()) throw new GeneratedSubmitError('transport', 'Form submit owner is no longer active.', false);
            return internals.fetchImpl(url, init);
          },
        });
        if (alive()) {
          form.setAttribute('data-can-submit-state', result.kind);
          if (result.kind === 'denied') {
            feedback(result.error.code, [
              result.error.message,
              ...(result.error.fields ?? []).map(field => field.message),
            ].join('\n'));
          }
          internals.onGeneratedFormResult?.(form, result);
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
        if (!stopped) releaseBusy();
        pending = false;
      }
    })();
  };
  form.addEventListener('submit', onSubmit);
  return () => {
    stopped = true;
    form.removeEventListener('submit', onSubmit);
    if (pending) {
      releaseBusy();
      form.removeAttribute('data-can-submit-state');
    }
  };
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
  // Completion/failure releases via the control's own lifecycle: a
  // swapped-out control unbinds (releasing nothing — the swap owns
  // the new state); htmx settles release through afterRequest below.
  const onSettled = (): void => {
    release();
  };
  control.addEventListener("can:settled", onSettled);
  return () => {
    control.removeEventListener("click", onClick);
    control.removeEventListener("can:settled", onSettled);
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

// Core binder seeds (catalog ids bound by this slice).
registerBinder("poll-region", bindPollRegion);
registerBinder("guarded-form", bindGuardedForm);
registerBinder("generated-form", bindGeneratedForm);
registerBinder("once-action", (root) => bindOnceAction(root));

/** Scan hooks: selector per core binder id. */
const BINDER_SELECTORS: ReadonlyArray<readonly [string, string]> = [
  ["poll-region", "[data-can-poll]"],
  ["guarded-form", "form[data-can-guard]"],
  ["generated-form", "form[data-can-generated-form]"],
  ["once-action", "[data-can-once]"],
];

/** Live clients by document: starting twice returns the same client. */
const LIVE_CLIENTS = new WeakMap<object, BrowserClient>();

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
 * A stopped client is terminal: start again for a fresh client. The
 * client never fetches on its own — only armed regions poll, and
 * only their declared URLs.
 */
export function startBrowserClient(options: BrowserClientOptions): BrowserClient {
  const document = options.window.document;
  const live = LIVE_CLIENTS.get(document as object);
  if (live !== undefined) {
    return live;
  }
  const internals: ClientInternals = {
    fetchImpl: options.fetchImpl,
    windowRef: options.window,
    document,
    visibility: options.visibility ?? document,
    ...(options.onGeneratedFormResult === undefined ? {} : { onGeneratedFormResult: options.onGeneratedFormResult }),
    ...(options.onGeneratedFormError === undefined ? {} : { onGeneratedFormError: options.onGeneratedFormError }),
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
      if (restartPolling) {
        for (let index = bound.length - 1; index >= 0; index -= 1) {
          const entry = bound[index];
          if (entry?.binder === 'poll-region') { bound.splice(index, 1); entry.stop(); }
        }
      }
      const snapshot = new Map(BINDERS);
      for (const [id, selector] of BINDER_SELECTORS) {
        const binder = snapshot.get(id);
        if (binder === undefined) {
          continue;
        }
        for (const element of document.querySelectorAll(selector)) {
          const signature = `${client.contextKey()}|${element.getAttribute('data-can-poll-url') ?? ''}|${element.getAttribute('data-can-poll-interval') ?? ''}|${element.getAttribute('data-can-poll-context') ?? ''}|${element.getAttribute('data-can-generated-form') ?? ''}|${element.getAttribute('action') ?? ''}`;
          const oldIndex = bound.findIndex((entry) => entry.element === element && entry.binder === id);
          const old = bound[oldIndex];
          if (old !== undefined && old.signature === signature) continue;
          if (old !== undefined) { bound.splice(oldIndex, 1); old.stop(); }
          bound.push({ element, binder: id, signature, stop: binder(element, client, internals) });
        }
      }
      // Release bindings whose elements left the document (swap
      // replacement owns the new state; stale bindings never linger).
      for (let index = bound.length - 1; index >= 0; index -= 1) {
        const entry = bound[index];
        if (entry !== undefined && (!entry.element.isConnected ||
            (entry.binder === 'poll-region' && !entry.element.hasAttribute('data-can-poll')) ||
            (entry.binder === 'generated-form' && !entry.element.hasAttribute('data-can-generated-form')))) {
          bound.splice(index, 1);
          entry.stop();
        }
      }
    },
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
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
  fetch(url: string, init: SubmitFetchInit & { readonly credentials: string; readonly cache: string }): Promise<{
    readonly status: number; readonly redirected?: boolean;
    readonly headers: { get(name: string): string | null }; text(): Promise<string>;
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
      return { status: response.redirected === true ? 409 : response.status, headers: response.headers, text: () => response.text() };
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
      attributeFilter: ['data-can-context', 'data-can-poll', 'data-can-poll-context', 'data-can-logged-out'],
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
