/**
 * Authorized one-inflight region polling (FP.BROWSER client half).
 *
 * Owns the poll lifecycle the server contracts assume (htmx `pollTrigger`
 * cadence, DESIGN refresh contract, CanDo refresh rules): exactly one
 * request in flight per region; a new tick aborts the previous
 * request AND drops its late response by sequence, so obsolete
 * responses can never paint. Polling terminates — never merely
 * pauses-and-resumes-stale — on hidden visibility, on context change
 * (the region's page/principal/team key no longer matches), and on
 * logout; the owner restarts explicitly against a fresh context.
 *
 * DOM-free core with injected deps (fetch/timers/visibility/context),
 * mirroring `client.ts` structural style: satisfied by the real DOM
 * in `bootstrap.ts` and by fakes in tests. No htmx dependency: swap
 * delivery is the caller's `onResponse` (htmx swap, morph, or manual
 * patch); bootstrap re-arms regions after swaps.
 *
 * Ticks run on strict cadence, independent of fetch latency: each
 * tick aborts the previous request (when still in flight) and
 * supersedes its sequence, so a slow or hung fetch self-heals on
 * the next tick and its late response is always dropped.
 */
import type { SubmitFetch, SubmitFetchResponse } from "../client.js";

/** Why a poll region stopped. */
export type PollStopReason =
  | "hidden"
  | "context-changed"
  | "logout"
  | "owner-stop"
  | "region-gone"
  | "response-refused";

/** Minimal visibility source (satisfied by `document`). */
export interface VisibilityLike {
  readonly visibilityState: string;
}

/** Clock + timers (satisfied by the global scope). */
export interface PollTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Region context supply. `key` names the current page/principal/team
 * context; `isAlive` reports whether the region is still mounted and
 * admitted. Both are read on every tick AND on every response, so a
 * context that changes mid-flight terminates before painting.
 */
export interface PollContext {
  key(): string;
  isAlive(): boolean;
}

/** Region fetch: GET the poll URL with an abort signal. */
export type PollFetch = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<SubmitFetchResponse>;

export interface PollRegionOptions {
  /** Poll GET URL supplied by the region markup; never invented here. */
  readonly url: string;
  /** Cadence in seconds (DESIGN poll bounds; htmx `pollTrigger` cadence). */
  readonly intervalSeconds: number;
  /** Context captured at arm time; ticks stop when it no longer matches. */
  readonly contextKey: string;
  readonly fetchImpl: PollFetch;
  readonly timers: PollTimers;
  readonly visibility: VisibilityLike;
  readonly context: PollContext;
  /** True once the principal is logged out (polling must terminate, never resume). */
  readonly isLoggedOut: () => boolean;
  /** Deliver an admitted success body, or a current-context 403 with an empty body to withdraw stale controls. */
  readonly onResponse: (body: string, status: number) => boolean | void;
  /** Optional stop notification (hidden/context/logout/owner/gone). */
  readonly onStop?: (reason: PollStopReason) => void;
  /**
   * Optional failure notification (transport/parse); the region keeps
   * its cadence with bounded backoff — failures never terminate, and
   * the failed response never paints.
   */
  readonly onError?: (message: string) => void;
  /**
   * Backoff schedule in ms applied per consecutive failure, capped at
   * the last entry. Defaults to no backoff (steady cadence).
   */
  readonly backoffMs?: readonly number[];
}

/**
 * One region's poll loop. `start` is idempotent; `stop` is total and
 * terminal for this controller (restart by constructing again, so a
 * restarted poll always re-proves its context).
 */
export class PollRegion {
  private timer: unknown = null;
  private inflight: AbortController | null = null;
  private sequence = 0;
  private failures = 0;
  private stopped = false;

  constructor(private readonly options: PollRegionOptions) {}

  /** Whether the loop is armed (started and not stopped). */
  get running(): boolean {
    return this.timer !== null && !this.stopped;
  }

  start(): void {
    if (this.stopped || this.timer !== null) {
      return;
    }
    this.schedule(0);
  }

  stop(reason: PollStopReason = "owner-stop"): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.timer !== null) {
      this.options.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    this.abortInflight();
    this.options.onStop?.(reason);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = this.options.timers.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
  }

  private reschedule(delayMs: number): void {
    if (this.timer !== null) {
      this.options.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    this.schedule(delayMs);
  }

  private abortInflight(): void {
    if (this.inflight !== null) {
      this.inflight.abort();
      this.inflight = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.options.isLoggedOut()) {
      this.stop("logout");
      return;
    }
    if (this.options.visibility.visibilityState === "hidden") {
      this.stop("hidden");
      return;
    }
    if (!this.options.context.isAlive()) {
      this.stop("region-gone");
      return;
    }
    if (this.options.context.key() !== this.options.contextKey) {
      this.stop("context-changed");
      return;
    }
    // Strict cadence: the next tick is already scheduled before the
    // fetch starts, so a slow fetch never slows the loop.
    this.schedule(this.options.intervalSeconds * 1000);
    // One in flight: abort the previous request, then supersede its
    // sequence so even an unabortable late response is dropped.
    this.abortInflight();
    this.sequence += 1;
    const mine = this.sequence;
    const controller = new AbortController();
    this.inflight = controller;
    let response: SubmitFetchResponse;
    try {
      response = await this.options.fetchImpl(this.options.url, { signal: controller.signal });
    } catch (error) {
      if (this.stopped || mine !== this.sequence) {
        return;
      }
      this.inflight = null;
      // Aborts are supersession, not failure: stay silent, keep cadence.
      if (controller.signal.aborted) {
        return;
      }
      this.failures += 1;
      const messageText = error instanceof Error ? error.message : String(error);
      this.options.onError?.(`Poll request failed: ${messageText}`);
      this.reschedule(this.nextDelayMs());
      return;
    }
    if (this.stopped || mine !== this.sequence) {
      return;
    }
    // Keep the controller owned until body reading settles, so stop or
    // supersession can also abort a cooperating transport's body read.
    // Re-prove context AFTER the await: a context that changed
    // mid-flight terminates before the response can paint.
    if (this.options.isLoggedOut()) {
      this.stop("logout");
      return;
    }
    if (!this.options.context.isAlive()) {
      this.stop("region-gone");
      return;
    }
    if (this.options.context.key() !== this.options.contextKey) {
      this.stop("context-changed");
      return;
    }
    if (response.status === 403) {
      if (this.options.visibility.visibilityState === 'hidden') { this.stop('hidden'); return; }
      this.options.onResponse('', response.status);
      this.stop('response-refused');
      return;
    }
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      if (this.stopped || mine !== this.sequence) {
        return;
      }
      this.inflight = null;
      this.failures += 1;
      const messageText = error instanceof Error ? error.message : String(error);
      this.options.onError?.(`Poll response unreadable: ${messageText}`);
      this.reschedule(this.nextDelayMs());
      return;
    }
    if (this.stopped || mine !== this.sequence) {
      return;
    }
    this.inflight = null;
    // Reading the body is another await: re-prove every paint condition.
    if (this.options.visibility.visibilityState === "hidden") { this.stop("hidden"); return; }
    if (this.options.isLoggedOut()) { this.stop("logout"); return; }
    if (!this.options.context.isAlive()) { this.stop("region-gone"); return; }
    if (this.options.context.key() !== this.options.contextKey) { this.stop("context-changed"); return; }
    if (response.status < 200 || response.status >= 300) { this.stop("response-refused"); return; }
    this.failures = 0;
    if (this.options.onResponse(body, response.status) === false) this.stop("response-refused");
  }

  private nextDelayMs(): number {
    const backoff = this.options.backoffMs;
    if (backoff === undefined || backoff.length === 0) {
      return this.options.intervalSeconds * 1000;
    }
    const capped = backoff[Math.min(this.failures - 1, backoff.length - 1)];
    return Math.max(this.options.intervalSeconds * 1000, capped ?? 0);
  }
}

/**
 * Forward the poll signal to transports that support it, and race fetch
 * against abort for injected transports that ignore it. The race drops
 * obsolete responses; only a cooperating transport cancels its work.
 */
export function submitFetchPollFetch(fetchImpl: SubmitFetch): PollFetch {
  return (url, init) =>
    new Promise<SubmitFetchResponse>((resolve, reject) => {
      if (init.signal.aborted) {
        reject(new DOMException("Poll request aborted.", "AbortError"));
        return;
      }
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        init.signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        try { release(); }
        catch { /* Abort remains the operative failure. */ }
        reject(new DOMException("Poll request aborted.", "AbortError"));
      };
      init.signal.addEventListener("abort", onAbort, { once: true });
      let pending: Promise<SubmitFetchResponse>;
      try {
        pending = fetchImpl(url, { method: "GET", headers: { "HX-Request": "true", "Accept": "text/html" }, signal: init.signal });
      } catch (error) {
        try { release(); }
        catch { /* The fetch acquisition failure remains operative. */ }
        reject(error);
        return;
      }
      void pending.then(
        (response) => {
          try { release(); }
          catch (error) { reject(error); return; }
          resolve(response);
        },
        (error: unknown) => {
          try { release(); }
          catch { /* The transport failure remains operative. */ }
          reject(error);
        },
      );
    });
}
