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
 * Behaviors (all progressive enhancement — the page works without
 * JS; no-htmx pages simply skip swap hooks):
 *
 * - Poll regions: `[data-can-poll]` elements arm one `PollRegion`
 *   each (`data-can-poll-url`, `data-can-poll-interval`,
 *   `data-can-poll-context`); regions re-arm after htmx swaps and
 *   terminate on hidden/context/logout/region-gone per polling.ts.
 * - Unsaved forms: `form[data-can-guard]` tracks dirtiness; a dirty
 *   form arms `beforeunload`, and submit clears it. Navigation away
 *   with unsaved input warns; no other form is affected.
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
import type { SubmitFetch } from "../client.js";

/** Minimal structural document (satisfied by DOM Document and fakes). */
export interface DocumentLike {
  readonly body: ElementLike | null;
  readonly activeElement: ElementLike | null;
  querySelectorAll(selectors: string): Iterable<ElementLike>;
  getElementById(id: string): ElementLike | null;
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
  preventDefault(): void;
}

/** Minimal structural window (satisfied by DOM Window and fakes). */
export interface WindowLike {
  readonly document: DocumentLike;
  readonly visibilityState: string;
  readonly location: { readonly hash: string };
  addEventListener(type: string, listener: (event: EventLike) => void): void;
  removeEventListener(type: string, listener: (event: EventLike) => void): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Client internals shared with binders (fetch, window, poll delivery). */
export interface ClientInternals {
  readonly fetchImpl: SubmitFetch;
  readonly windowRef: WindowLike;
  readonly deliver?: BrowserClientOptions["deliverPollResponse"];
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
  /**
   * htmx swap hook when htmx is present: called with a rescan
   * callback to invoke after every swap into `#can-main`. Absent
   * without htmx (regions arm once at start).
   */
  readonly onHtmxSwap?: (rescan: () => void) => () => void;
  /**
   * Deliver a poll response body for a region. Defaults to replacing
   * the region's content when the binder root supports it; htmx
   * pages pass a swap-based delivery.
   */
  readonly deliverPollResponse?: (region: ElementLike, body: string, status: number) => void;
}

export interface BrowserClient {
  /** Re-scan the document for bindable regions (also runs at start). */
  rescan(): void;
  /** Stop all regions, guards, and listeners. Terminal. */
  stop(): void;
  /** Current context key (`data-can-context` on `<body>`, "" when absent). */
  contextKey(): string;
}

interface BoundRegion {
  readonly element: ElementLike;
  readonly stop: () => void;
}

function parseIntervalSeconds(value: string | null): number | null {
  if (value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function bindPollRegion(
  region: ElementLike,
  client: BrowserClient,
  internals: ClientInternals,
): () => void {
  const url = region.getAttribute("data-can-poll-url");
  const interval = parseIntervalSeconds(region.getAttribute("data-can-poll-interval"));
  const context = region.getAttribute("data-can-poll-context") ?? client.contextKey();
  if (url === null || url === "" || interval === null) {
    return () => {};
  }
  const poller = new PollRegion({
    url,
    intervalSeconds: interval,
    contextKey: context,
    fetchImpl: submitFetchPollFetch(internals.fetchImpl),
    timers: internals.windowRef,
    visibility: internals.windowRef,
    context: {
      key: () => client.contextKey(),
      isAlive: () => region.isConnected,
    },
    isLoggedOut: () => region.getAttribute("data-can-logged-out") === "true",
    onResponse: (body, status) => {
      internals.deliver?.(region, body, status);
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
registerBinder("once-action", (root) => bindOnceAction(root));

/** Scan hooks: selector per core binder id. */
const BINDER_SELECTORS: ReadonlyArray<readonly [string, string]> = [
  ["poll-region", "[data-can-poll]"],
  ["guarded-form", "form[data-can-guard]"],
  ["once-action", "[data-can-once]"],
];

/** Live clients by document: starting twice returns the same client. */
const LIVE_CLIENTS = new WeakMap<object, BrowserClient>();

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
    ...(options.deliverPollResponse === undefined
      ? {}
      : { deliver: options.deliverPollResponse }),
  };
  const bound: BoundRegion[] = [];
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
    contextKey: () => document.body?.getAttribute("data-can-context") ?? "",
    rescan: () => {
      if (stopped) {
        return;
      }
      const snapshot = new Map(BINDERS);
      for (const [id, selector] of BINDER_SELECTORS) {
        const binder = snapshot.get(id);
        if (binder === undefined) {
          continue;
        }
        for (const element of document.querySelectorAll(selector)) {
          if (bound.some((entry) => entry.element === element)) {
            continue;
          }
          bound.push({ element, stop: binder(element, client, internals) });
        }
      }
      // Release bindings whose elements left the document (swap
      // replacement owns the new state; stale bindings never linger).
      for (let index = bound.length - 1; index >= 0; index -= 1) {
        const entry = bound[index];
        if (entry !== undefined && !entry.element.isConnected) {
          entry.stop();
          bound.splice(index, 1);
        }
      }
    },
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      releaseSwapHook?.();
      releaseSwapHook = null;
      options.window.removeEventListener("hashchange", hashListener);
      options.window.removeEventListener("keydown", keyListener);
      for (const entry of bound) {
        entry.stop();
      }
      bound.length = 0;
      LIVE_CLIENTS.delete(document as object);
    },
  };

  options.window.addEventListener("hashchange", hashListener);
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
}
