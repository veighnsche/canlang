/**
 * FP.EXPORT browser consumer: authenticated CSV export requests over the
 * released HTTP export contract (`interfaces/src/http/export.ts`).
 *
 * The consumer READS the contract; it never re-implements the server:
 * `submitExportRequest` POSTs the caller-declared operation/columns/limit
 * as JSON with the CSRF header (session cookie travels via the host
 * fetch binding), and the inline CSV returns byte-exact — server
 * formula neutralization and quoting pass through untouched (this
 * module never strips or re-protects cells).
 *
 * Completion is explicit, never inferred: only `complete &&
 * !truncated` derives `inline-complete`. A download descriptor means
 * `truncated-pending` (or `expired` past its guarded expiry) — the
 * descriptor alone never completes, contradictory flags fail toward
 * pending, and `downloadInlineCsv` refuses anything but
 * inline-complete. Pending renders the D-owned download/status links
 * (guarded, `safeHref`'d) with an explicit no-polling note: this build
 * issues exactly one fetch per request and never touches status or
 * download URLs, because the large-output service behind them is
 * D-domain follow-up — polling it would invent its behavior.
 *
 * Cancellation is host-driven: an `ExportController` fails fast before
 * fetch and converts late responses to `{code:'cancelled'}` (stale
 * responses never render). Errors digest to code/message/fields (never
 * raw bodies); transport throws and unparseable bodies map to
 * `{code:'transport'}`; parsed-but-malformed success bodies throw
 * (contract violation, host-fatal — the F `csv/*` precedent).
 *
 * Download filenames sanitize (path segments dropped, separators
 * collapsed, length capped, `.csv` forced) and every rendered string
 * escapes for its sink.
 */
import { CSRF_FIELD } from "../../../contracts/src/presentation.js";
import type { SubmitFetch, SubmitFetchResponse } from "../client.js";
import { escapeAttr, escapeHtml, safeHref } from "../escape.js";
import { assertRegionId } from "../htmx.js";

/**
 * Session CSRF header spelling. Pins the identity-owned spelling the
 * dispatcher asserts (`x-csrf-token`; client.ts and csv/parse.ts carry
 * the same local spelling, which this scope must not touch to
 * re-export).
 */
export const EXPORT_CSRF_HEADER = "x-csrf-token";

/** Download MIME for inline CSV payloads. */
export const EXPORT_CSV_MIME = "text/csv;charset=utf-8";

/** Server error digest: code + safe message + optional field errors. */
export interface ExportBusinessError {
  readonly code: string;
  readonly message: string;
  readonly fields?: ReadonlyArray<{
    readonly path: string;
    readonly code?: string;
    readonly message: string;
  }>;
  readonly retryable?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Digest server error JSON into a renderable shape. Returns null when
 * the value is not error-shaped (caller decides: transport fallback).
 * Never throws on data; never passes raw bodies through.
 */
export function digestExportError(value: unknown): ExportBusinessError | null {
  if (!isRecord(value)) return null;
  const code = value["code"];
  const message = value["message"];
  if (typeof code !== "string" || code === "" || typeof message !== "string" || message === "") {
    return null;
  }
  const fields = value["fields"];
  const digested: Array<{ path: string; code?: string; message: string }> = [];
  if (Array.isArray(fields)) {
    for (const entry of fields) {
      if (!isRecord(entry)) continue;
      const path = entry["path"];
      const fieldMessage = entry["message"];
      if (typeof path !== "string" || typeof fieldMessage !== "string") continue;
      const fieldCode = entry["code"];
      if (typeof fieldCode === "string") {
        digested.push({ path, code: fieldCode, message: fieldMessage });
      } else {
        digested.push({ path, message: fieldMessage });
      }
    }
  }
  return {
    code,
    message,
    ...(digested.length > 0 ? { fields: digested } : {}),
    ...(typeof value["retryable"] === "boolean" ? { retryable: value["retryable"] } : {}),
  };
}

/** Parsed download descriptor (contract shape; D fulfills the URLs). */
export interface ExportDescriptorModel {
  readonly handle: string;
  readonly status: "pending";
  readonly download_url: string;
  readonly status_url: string;
  readonly expires_at: string;
  readonly row_estimate: null;
  readonly truncated: true;
}

/** Parsed export outcome: completeness + currency + CSV + optional descriptor. */
export interface ExportOutcomeModel {
  readonly operation: string;
  readonly as_of: string;
  readonly complete: boolean;
  readonly row_count: number;
  readonly truncated: boolean;
  readonly next_cursor?: string;
  readonly columns: ReadonlyArray<{ readonly field: string; readonly label: string }>;
  readonly csv: string;
  readonly descriptor?: ExportDescriptorModel;
}

function contractError(need: string): Error {
  return new Error(`parseExportPayload: export outcome ${need}`);
}

function asDescriptor(value: unknown): ExportDescriptorModel {
  if (!isRecord(value)) throw contractError("needs a descriptor record when truncated");
  const handle = value["handle"];
  const status = value["status"];
  const download_url = value["download_url"];
  const status_url = value["status_url"];
  const expires_at = value["expires_at"];
  if (typeof handle !== "string" || handle === "") throw contractError("needs a descriptor handle");
  if (status !== "pending") throw contractError("needs a pending descriptor status");
  if (typeof download_url !== "string" || download_url === "") {
    throw contractError("needs a descriptor download_url");
  }
  if (typeof status_url !== "string" || status_url === "") {
    throw contractError("needs a descriptor status_url");
  }
  if (typeof expires_at !== "string" || expires_at === "") {
    throw contractError("needs a descriptor expires_at");
  }
  if (value["row_estimate"] !== null) throw contractError("needs a null descriptor row_estimate");
  if (value["truncated"] !== true) throw contractError("needs a truncated descriptor flag");
  return { handle, status: "pending", download_url, status_url, expires_at, row_estimate: null, truncated: true };
}

/**
 * Parse a 2xx export body into the outcome model. Throws on any
 * contract violation (missing members, mistyped flags, truncated
 * without a descriptor) — host-fatal, never rendered.
 */
export function parseExportPayload(value: unknown): ExportOutcomeModel {
  if (!isRecord(value)) throw contractError("needs an outcome record");
  const operation = value["operation"];
  const as_of = value["as_of"];
  const complete = value["complete"];
  const row_count = value["row_count"];
  const truncated = value["truncated"];
  const columns = value["columns"];
  const csv = value["csv"];
  if (typeof operation !== "string" || operation === "") throw contractError("needs an operation");
  if (typeof as_of !== "string" || as_of === "") throw contractError("needs as_of currency");
  if (typeof complete !== "boolean") throw contractError("needs a complete flag");
  if (typeof row_count !== "number" || !Number.isInteger(row_count) || row_count < 0) {
    throw contractError("needs a row_count");
  }
  if (typeof truncated !== "boolean") throw contractError("needs a truncated flag");
  if (typeof csv !== "string") throw contractError("needs csv text");
  if (!Array.isArray(columns)) throw contractError("needs a columns list");
  const parsedColumns: Array<{ field: string; label: string }> = [];
  for (const entry of columns) {
    if (!isRecord(entry) || typeof entry["field"] !== "string") {
      throw contractError("needs columns with field names");
    }
    const label = entry["label"];
    parsedColumns.push({ field: entry["field"], label: typeof label === "string" ? label : entry["field"] });
  }
  const next_cursor = value["next_cursor"];
  if (next_cursor !== undefined && typeof next_cursor !== "string") {
    throw contractError("needs a string next_cursor");
  }
  const descriptor = value["descriptor"];
  if (truncated && descriptor === undefined) {
    throw contractError("needs a descriptor when truncated");
  }
  return {
    operation,
    as_of,
    complete,
    row_count,
    truncated,
    ...(next_cursor === undefined ? {} : { next_cursor }),
    columns: parsedColumns,
    csv,
    ...(descriptor === undefined ? {} : { descriptor: asDescriptor(descriptor) }),
  };
}

/** Derived UI status: inline bytes in hand, pending large output, or expired. */
export type ExportDerivedStatus = "inline-complete" | "truncated-pending" | "expired";

/**
 * True when the descriptor's guarded expiry has passed (per the
 * caller clock). Unparseable `expires_at` fails closed (expired).
 */
export function isDescriptorExpired(descriptor: ExportDescriptorModel, nowMs: number): boolean {
  const expiresMs = Date.parse(descriptor.expires_at);
  return !Number.isFinite(expiresMs) || expiresMs <= nowMs;
}

/**
 * Derive the UI status from a parsed outcome. Only `complete &&
 * !truncated` completes; truncated outcomes pend (or expire) — the
 * descriptor alone never completes, and anything not provably
 * inline-complete and not pending reads as expired (fail toward
 * not-complete).
 */
export function deriveExportStatus(outcome: ExportOutcomeModel, nowMs: number): ExportDerivedStatus {
  if (outcome.truncated) {
    const descriptor = outcome.descriptor;
    if (descriptor === undefined) return "expired";
    return isDescriptorExpired(descriptor, nowMs) ? "expired" : "truncated-pending";
  }
  return outcome.complete ? "inline-complete" : "expired";
}

/** Host-driven cancellation: fail fast + ignore late responses. */
export interface ExportController {
  readonly cancelled: boolean;
  cancel(): void;
}

/** Create a fresh, uncancelled controller. */
export function createExportController(): ExportController {
  let flag = false;
  return {
    get cancelled(): boolean {
      return flag;
    },
    cancel(): void {
      flag = true;
    },
  };
}

export interface SubmitExportInput {
  readonly fetchImpl: SubmitFetch;
  /** Export POST path supplied by the caller; never invented here. */
  readonly action: string;
  readonly csrf: string;
  readonly operation: string;
  readonly columns?: ReadonlyArray<string>;
  readonly limit?: number;
  readonly cursor?: string;
  readonly parent?: { readonly id: string };
  readonly filters?: Record<string, unknown>;
  readonly controller?: ExportController;
}

export type SubmitExportResult =
  | { readonly ok: true; readonly outcome: ExportOutcomeModel }
  | { readonly ok: false; readonly error: ExportBusinessError };

function transportError(message: string): ExportBusinessError {
  return { code: "transport", message };
}

function cancelledError(): ExportBusinessError {
  return { code: "cancelled", message: "Export request cancelled." };
}

/**
 * POST one export request as JSON with the CSRF header. Server error
 * bodies digest; transport throws and unparseable bodies map to
 * `{code:'transport'}`; parsed-but-malformed success bodies throw
 * (contract violation — host-fatal). A cancelled controller fails fast
 * and converts late responses to `{code:'cancelled'}`.
 */
export async function submitExportRequest(input: SubmitExportInput): Promise<SubmitExportResult> {
  if (typeof input.action !== "string" || input.action === "") {
    throw new Error("submitExportRequest needs a non-empty action");
  }
  if (typeof input.csrf !== "string" || input.csrf === "") {
    throw new Error("submitExportRequest needs the CSRF token");
  }
  if (typeof input.operation !== "string" || input.operation === "") {
    throw new Error("submitExportRequest needs the operation");
  }
  if (input.controller?.cancelled) {
    return { ok: false, error: cancelledError() };
  }
  let response: SubmitFetchResponse;
  try {
    response = await input.fetchImpl(input.action, {
      method: "POST",
      headers: { "content-type": "application/json", [EXPORT_CSRF_HEADER]: input.csrf },
      body: JSON.stringify({
        operation: input.operation,
        ...(input.columns === undefined ? {} : { columns: [...input.columns] }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.parent === undefined ? {} : { parent: input.parent }),
        ...(input.filters === undefined ? {} : { filters: input.filters }),
      }),
    });
  } catch (error) {
    if (input.controller?.cancelled) {
      return { ok: false, error: cancelledError() };
    }
    const messageText = error instanceof Error ? error.message : String(error);
    return { ok: false, error: transportError(`Export request failed: ${messageText}`) };
  }
  if (input.controller?.cancelled) {
    return { ok: false, error: cancelledError() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    return { ok: false, error: transportError(`Export request failed (status ${String(response.status)}).`) };
  }
  if (input.controller?.cancelled) {
    return { ok: false, error: cancelledError() };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      error: digestExportError(parsed) ?? transportError(`Export request failed (status ${String(response.status)}).`),
    };
  }
  return { ok: true, outcome: parseExportPayload(parsed) };
}

/**
 * Sanitize an operation + as-of stamp into a download filename:
 * path segments dropped (`.`/`..`/empties), separators collapsed,
 * leading/trailing dots/dashes stripped, stem capped at 60 chars,
 * `yyyymmdd` date (or `nodate`), `.csv` forced.
 */
export function exportFilename(operation: string, asOf: string): string {
  const segments = operation.split(/[/\\]+/).filter((part) => part !== "" && part !== "." && part !== "..");
  const joined = segments.join("-").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const stem = joined.replace(/^[.-]+/, "").replace(/[.-]+$/, "").slice(0, 60).replace(/[.-]+$/, "");
  const dateMatch = /(\d{4})-(\d{2})-(\d{2})/.exec(asOf);
  const date = dateMatch === null ? "nodate" : `${dateMatch[1]}${dateMatch[2]}${dateMatch[3]}`;
  return `${stem === "" ? "export" : stem}-${date}.csv`;
}

/** Host download binding (browser: Blob anchor; tests: capture). */
export interface DownloadSink {
  save(filename: string, text: string, mime: string): void;
}

/**
 * Save an inline-complete outcome through the host sink. Refuses
 * anything but inline-complete (descriptor-only downloads would be
 * false completion) and returns the sanitized filename.
 */
export function downloadInlineCsv(sink: DownloadSink, outcome: ExportOutcomeModel, nowMs: number): string {
  if (deriveExportStatus(outcome, nowMs) !== "inline-complete") {
    throw new Error("downloadInlineCsv needs an inline-complete outcome (descriptor-only never downloads)");
  }
  const filename = exportFilename(outcome.operation, outcome.as_of);
  sink.save(filename, outcome.csv, EXPORT_CSV_MIME);
  return filename;
}

/** Renderable export-panel state (absent = pristine form). */
export type ExportPanelStatus =
  | { readonly kind: "inline-complete" | "truncated-pending" | "expired"; readonly outcome: ExportOutcomeModel }
  | { readonly kind: "failed"; readonly error: ExportBusinessError };

export interface ExportPanelProps {
  readonly regionId: string;
  readonly action: string;
  readonly csrf: string;
  readonly operations: ReadonlyArray<string>;
  readonly status?: ExportPanelStatus;
}

function renderResult(status: ExportPanelStatus): string {
  if (status.kind === "failed") {
    return (
      `<p role="alert">Export failed (${escapeHtml(status.error.code)}): ` +
      `${escapeHtml(status.error.message)}</p>`
    );
  }
  const outcome = status.outcome;
  const summary =
    `<p>${escapeHtml(String(outcome.row_count))} rows, as of ${escapeHtml(outcome.as_of)}.</p>`;
  if (status.kind === "inline-complete") {
    const filename = exportFilename(outcome.operation, outcome.as_of);
    return (
      summary +
      `<button type="button" data-export-download="${escapeAttr(filename)}">Download CSV</button>`
    );
  }
  if (status.kind === "expired") {
    return summary + `<p role="alert">The large-output download expired; request a fresh export.</p>`;
  }
  const descriptor = outcome.descriptor;
  const links =
    descriptor === undefined
      ? ""
      : `<p><a href="${escapeAttr(safeHref(descriptor.download_url))}">Download large output</a> ` +
        `<a href="${escapeAttr(safeHref(descriptor.status_url))}">Check status</a></p>` +
        `<p>Available until ${escapeHtml(descriptor.expires_at)}.</p>`;
  return (
    summary +
    `<p role="status">Large output pending — more rows remain. This view does not poll for completion.</p>` +
    links
  );
}

/**
 * Render the export panel: declared-operation form (caller-supplied
 * operations + action, stable wiring ids) plus the result region.
 * Dynamic strings escape; descriptor hrefs pass `safeHref`.
 */
export function renderExportPanel(props: ExportPanelProps): string {
  assertRegionId(props.regionId);
  if (typeof props.action !== "string" || props.action === "") {
    throw new Error("renderExportPanel needs a non-empty action");
  }
  if (typeof props.csrf !== "string" || props.csrf === "") {
    throw new Error("renderExportPanel needs the CSRF token");
  }
  const options = props.operations
    .map((name) => `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`)
    .join("");
  const result = props.status === undefined ? "" : renderResult(props.status);
  return (
    `<section id="${escapeAttr(props.regionId)}" data-export-action="${escapeAttr(props.action)}">` +
    `<form data-export-form>` +
    `<input type="hidden" name="${escapeAttr(CSRF_FIELD)}" value="${escapeAttr(props.csrf)}">` +
    `<label>Operation<select data-export-operation>${options}</select></label>` +
    `<label>Limit<input data-export-limit type="number" min="1" max="500"></label>` +
    `<button type="submit">Export CSV</button>` +
    `</form>` +
    `<div data-export-result>${result}</div>` +
    `</section>`
  );
}
