/**
 * FP.EXPORT browser consumer: declared Print views over the released
 * HTTP Print contract (`interfaces/src/http/print.ts`).
 *
 * Views are DECLARED, never invented: the caller names a view, the
 * name validates (`^[a-z0-9-]+$`, fail closed — no traversal, no
 * selection smuggling), and the print base path is caller-supplied.
 * Grants stay current because every `fetchPrintView` call issues a
 * live GET — no caching, so a revocation between opens denies the
 * next one.
 *
 * Security limits: print URLs pass `safeHref` (unsafe bases fall back
 * to `#`); the frame render sandboxes scripts out; server HTML is
 * never inlined into the host page (link/frame navigation only), so a
 * compromised print body cannot script the host. Errors digest to
 * code/message (never raw bodies); non-HTML 2xx answers and transport
 * throws map to `{code:'transport'}`.
 */
import type { ExportBusinessError } from "./export.js";
import { digestExportError } from "./export.js";
import type { SubmitFetch, SubmitFetchResponse } from "../client.js";
import { escapeAttr, escapeHtml, safeHref } from "../escape.js";
import { assertRegionId } from "../htmx.js";

/** Declared print-view name shape (fail closed on anything else). */
export const PRINT_VIEW_PATTERN = /^[a-z0-9-]+$/;

export interface FetchPrintInput {
  readonly fetchImpl: SubmitFetch;
  /** Print base path supplied by the caller; never invented here. */
  readonly printBase: string;
  readonly view: string;
  readonly limit?: number;
  readonly cursor?: string;
  /** Host cancellation; forwarded to transports that support abort. */
  readonly signal?: AbortSignal;
}

export type FetchPrintResult =
  | { readonly ok: true; readonly html: string; readonly view: string }
  | { readonly ok: false; readonly error: ExportBusinessError };

function transportError(message: string): ExportBusinessError {
  return { code: "transport", message };
}

function cancelledError(): ExportBusinessError {
  return { code: "cancelled", message: "Print request cancelled." };
}

function printUrl(printBase: string, view: string, limit?: number, cursor?: string): string {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (cursor !== undefined) params.set("cursor", cursor);
  const query = params.toString();
  return query === "" ? `${printBase}/${view}` : `${printBase}/${view}?${query}`;
}

/**
 * GET one declared print view as HTML. No caching — every call reads
 * live (current grants per open). Non-HTML 2xx answers, transport
 * throws (including body reads), and unparseable error bodies map to
 * `{code:'transport'}`; server error JSON digests. An aborted host signal
 * fails fast and suppresses late results, even if the transport ignores it.
 */
export async function fetchPrintView(input: FetchPrintInput): Promise<FetchPrintResult> {
  if (typeof input.printBase !== "string" || input.printBase === "") {
    throw new Error("fetchPrintView needs a non-empty printBase");
  }
  if (typeof input.view !== "string" || !PRINT_VIEW_PATTERN.test(input.view)) {
    throw new Error(`fetchPrintView needs a declared view name (got ${JSON.stringify(input.view)})`);
  }
  if (input.signal?.aborted) {
    return { ok: false, error: cancelledError() };
  }
  const url = printUrl(input.printBase, input.view, input.limit, input.cursor);
  let response: SubmitFetchResponse;
  let body: string;
  try {
    response = await input.fetchImpl(url, {
      method: "GET", headers: {},
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (input.signal?.aborted) {
      return { ok: false, error: cancelledError() };
    }
    body = await response.text();
  } catch {
    return { ok: false, error: input.signal?.aborted ? cancelledError() : transportError("Print request failed.") };
  }
  if (input.signal?.aborted) {
    return { ok: false, error: cancelledError() };
  }
  if (response.status < 200 || response.status >= 300) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
    return {
      ok: false,
      error: digestExportError(parsed) ?? transportError(`Print request failed (status ${String(response.status)}).`),
    };
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) {
    return { ok: false, error: transportError("Print request failed (non-HTML answer).") };
  }
  return { ok: true, html: body, view: input.view };
}

export interface PrintLinkProps {
  readonly printBase: string;
  readonly view: string;
  readonly label?: string;
}

/**
 * Render a new-tab anchor to a declared print view. The name
 * validates (fail closed); the href passes `safeHref`.
 */
export function renderPrintLink(props: PrintLinkProps): string {
  if (typeof props.view !== "string" || !PRINT_VIEW_PATTERN.test(props.view)) {
    throw new Error(`renderPrintLink needs a declared view name (got ${JSON.stringify(props.view)})`);
  }
  const href = escapeAttr(safeHref(`${props.printBase}/${props.view}`));
  const label = escapeHtml(props.label ?? `Print ${props.view}`);
  return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
}

export interface PrintFrameProps {
  readonly regionId: string;
  readonly printBase: string;
  readonly view: string;
  readonly title?: string;
}

/**
 * Render a sandboxed frame hosting a declared print view. Scripts
 * stay out (`sandbox=""`); the src passes `safeHref`; server HTML is
 * navigated to, never inlined.
 */
export function renderPrintFrame(props: PrintFrameProps): string {
  assertRegionId(props.regionId);
  if (typeof props.view !== "string" || !PRINT_VIEW_PATTERN.test(props.view)) {
    throw new Error(`renderPrintFrame needs a declared view name (got ${JSON.stringify(props.view)})`);
  }
  const src = escapeAttr(safeHref(`${props.printBase}/${props.view}`));
  const title = escapeAttr(props.title ?? props.view);
  return (
    `<section id="${escapeAttr(props.regionId)}">` +
    `<iframe src="${src}" sandbox="" title="${title}"></iframe>` +
    `</section>`
  );
}
