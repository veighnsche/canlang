/**
 * FP.CSV UI third 2/3: review preview + selection + review transport.
 *
 * `csvPreviewSection` renders one server `CsvReview` verbatim: counts,
 * consent echo, and EVERY row preserved — valid rows selectable,
 * invalid rows with their kept errors, duplicates pointing at their
 * first occurrence. Selection is valid-rows-only (checkboxes); the
 * commit form carries hidden operation, CSV echo, consent fields, CSRF,
 * and one render-minted `operation_id` replay key per valid row (see
 * `mintOperationId` in confirm.ts — the server's 24h age budget covers
 * review-then-commit sessions; the host re-renders to re-mint).
 *
 * Flat-map collection contract (confirm.ts `collectCommitSelections`
 * reads it): `consent.<field>` for the five consent members, `csv`
 * for the echoed CSV text, `rows[<index>].selected = on` for checked
 * valid rows, `rows[<index>].operation_id` for the replay key.
 *
 * `submitCsvReview` POSTs `{operation, csv}` as JSON with the CSRF
 * header (the CSV endpoints reject non-JSON bodies, so plain forms
 * and hx-post cannot drive them — the host wires this helper).
 * Server error bodies digest to `CsvBusinessError`; transport
 * failures become `{code:'transport'}`; a malformed success body is a
 * contract violation and throws (host-fatal, like other UI guards).
 */

import type { PresentationContext } from "../../../contracts/src/presentation.js";
import { CSRF_FIELD } from "../../../contracts/src/presentation.js";
import type { SubmitFetch, SubmitFetchResponse } from "../client.js";
import {
  csvFormulaProtect,
  escapeAttr,
  escapeHtml,
  isolate,
} from "../escape.js";
import { assertRegionId, fragmentRegion } from "../htmx.js";
import { message, resolveCaption } from "../messages.js";
import { mintOperationId } from "./confirm.js";
import type { CsvBusinessError, CsvRenewalHook } from "./parse.js";
import { CSV_CSRF_HEADER, digestBusinessError } from "./parse.js";

/** One preserved row verdict, mirroring server CsvRowReview JSON. */
export type CsvRowStatus = "valid" | "invalid" | "duplicate";

export interface CsvPreviewRow {
  readonly index: number;
  readonly status: CsvRowStatus;
  readonly inputs: Record<string, unknown>;
  readonly error?: CsvBusinessError;
  readonly duplicate_of?: number;
}

/** Review consent, mirroring server CsvConsent JSON. */
export interface CsvConsentModel {
  readonly review_id: string;
  readonly operation: string;
  readonly principal: string;
  readonly candidates_digest: string;
  readonly candidate_count: number;
}

/** Full review, mirroring server CsvReview JSON. */
export interface CsvReviewModel {
  readonly operation: string;
  readonly review_id: string;
  readonly consent: CsvConsentModel;
  readonly rows: ReadonlyArray<CsvPreviewRow>;
  readonly counts: {
    readonly total: number;
    readonly valid: number;
    readonly invalid: number;
    readonly duplicate: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function fail(where: string): Error {
  return new Error(`parseReviewPayload: malformed review (${where})`);
}

/**
 * Guard server review JSON into a renderable model. Throws on malformed
 * bodies (contract violation — host-fatal). Never passes raw bodies
 * through: errors digest, inputs stay unknown-valued until render
 * armor (`csvFormulaProtect` + escape + isolate per cell).
 */
export function parseReviewPayload(value: unknown): CsvReviewModel {
  if (!isRecord(value)) throw fail("body");
  const operation = value["operation"];
  const review_id = value["review_id"];
  if (typeof operation !== "string" || operation === "") throw fail("operation");
  if (typeof review_id !== "string" || review_id === "") throw fail("review_id");
  const consent = value["consent"];
  if (!isRecord(consent)) throw fail("consent");
  const reviewId = consent["review_id"];
  const consentOp = consent["operation"];
  const principal = consent["principal"];
  const digest = consent["candidates_digest"];
  const count = consent["candidate_count"];
  if (typeof reviewId !== "string" || reviewId === "") throw fail("consent.review_id");
  if (typeof consentOp !== "string" || consentOp === "") throw fail("consent.operation");
  if (typeof principal !== "string" || principal === "") throw fail("consent.principal");
  if (typeof digest !== "string" || digest === "") throw fail("consent.candidates_digest");
  if (!isSafeIndex(count)) throw fail("consent.candidate_count");
  const rawRows = value["rows"];
  if (!Array.isArray(rawRows)) throw fail("rows");
  const rows: CsvPreviewRow[] = [];
  for (const entry of rawRows) {
    if (!isRecord(entry)) throw fail("rows[]");
    const index = entry["index"];
    const status = entry["status"];
    const inputs = entry["inputs"];
    if (!isSafeIndex(index)) throw fail("rows[].index");
    if (status !== "valid" && status !== "invalid" && status !== "duplicate") {
      throw fail("rows[].status");
    }
    if (!isRecord(inputs)) throw fail("rows[].inputs");
    const row: {
      index: number;
      status: CsvRowStatus;
      inputs: Record<string, unknown>;
      error?: CsvBusinessError;
      duplicate_of?: number;
    } = { index, status, inputs: { ...inputs } };
    if (entry["error"] !== undefined) {
      const error = digestBusinessError(entry["error"]);
      if (error === null) throw fail("rows[].error");
      row.error = error;
    }
    if (entry["duplicate_of"] !== undefined) {
      if (!isSafeIndex(entry["duplicate_of"])) throw fail("rows[].duplicate_of");
      row.duplicate_of = entry["duplicate_of"];
    }
    rows.push(row);
  }
  const counts = value["counts"];
  if (!isRecord(counts)) throw fail("counts");
  const total = counts["total"];
  const valid = counts["valid"];
  const invalid = counts["invalid"];
  const duplicate = counts["duplicate"];
  if (!isSafeIndex(total) || !isSafeIndex(valid) || !isSafeIndex(invalid) || !isSafeIndex(duplicate)) {
    throw fail("counts.*");
  }
  return {
    operation,
    review_id,
    consent: {
      review_id: reviewId,
      operation: consentOp,
      principal,
      candidates_digest: digest,
      candidate_count: count,
    },
    rows,
    counts: { total, valid, invalid, duplicate },
  };
}

const PREVIEW_HEADING = message("CSV review", { nl: "CSV-beoordeling" });
const COUNT_ROWS = message("rows", { nl: "rijen" });
const COUNT_VALID = message("valid", { nl: "geldig" });
const COUNT_INVALID = message("invalid", { nl: "ongeldig" });
const COUNT_DUPLICATE = message("duplicate", { nl: "duplicaat" });
const CONSENT_REVIEW = message("Review", { nl: "Beoordeling" });
const CONSENT_CANDIDATES = message("candidates", { nl: "kandidaten" });
const CONSENT_DIGEST = message("digest", { nl: "digest" });
const COL_SELECT = message("Commit?", { nl: "Vastleggen?" });
const COL_ROW = message("Row", { nl: "Rij" });
const COL_STATUS = message("Status", { nl: "Status" });
const COL_INPUTS = message("Inputs", { nl: "Invoer" });
const COL_DETAIL = message("Detail", { nl: "Detail" });
const STATUS_VALID = message("Valid", { nl: "Geldig" });
const STATUS_INVALID = message("Invalid", { nl: "Ongeldig" });
const STATUS_DUPLICATE = message("Duplicate", { nl: "Duplicaat" });
const DUPLICATE_OF = message("duplicate of row", { nl: "duplicaat van rij" });
const COMMIT_SUBMIT = message("Commit selected rows", { nl: "Geselecteerde rijen vastleggen" });
const NO_VALID_ROWS = message("No valid rows to commit.", { nl: "Geen geldige rijen om vast te leggen." });

export interface CsvPreviewProps {
  readonly context: PresentationContext;
  readonly review: CsvReviewModel;
  /** Commit POST path supplied by the caller; never invented here. */
  readonly commitPath: string;
  /** CSV text echoed back for the commit round trip (server re-parses). */
  readonly csvText: string;
  /** Preview region id (self) the host swaps review HTML into. */
  readonly regionId: string;
  /** Optional consent-renewal notice (stale consent, changed candidates). */
  readonly renewal?: CsvRenewalHook;
}

function renderArmoredValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "null";
  return isolate(escapeHtml(csvFormulaProtect(text)));
}

function renderInputsList(inputs: Record<string, unknown>): string {
  const entries = Object.entries(inputs);
  if (entries.length === 0) return "";
  const items = entries
    .map(([name, value]) => `<li><code>${escapeHtml(name)}</code>: ${renderArmoredValue(value)}</li>`)
    .join("");
  return `<ul>${items}</ul>`;
}

function renderRowError(error: CsvBusinessError): string {
  const fields = (error.fields ?? [])
    .map(
      (field) =>
        `<li><code>${escapeHtml(field.path)}</code>: ${escapeHtml(field.message)}</li>`,
    )
    .join("");
  return (
    `<p>${escapeHtml(error.message)}</p>` +
    (fields === "" ? "" : `<ul>${fields}</ul>`)
  );
}

function renderPreviewRow(
  row: CsvPreviewRow,
  context: PresentationContext,
  operationId: string | null,
): string {
  const anchor = `csv-row-${String(row.index)}`;
  const statusText =
    row.status === "valid"
      ? resolveCaption(STATUS_VALID, context)
      : row.status === "invalid"
        ? resolveCaption(STATUS_INVALID, context)
        : resolveCaption(STATUS_DUPLICATE, context);
  let select = "";
  if (row.status === "valid" && operationId !== null) {
    select =
      `<input type="checkbox" name="rows[${String(row.index)}].selected" value="on" checked> ` +
      `<input type="hidden" name="rows[${String(row.index)}].operation_id" value="${escapeAttr(operationId)}">`;
  }
  let detail = "";
  if (row.status === "invalid" && row.error !== undefined) {
    detail = renderRowError(row.error);
  } else if (row.status === "duplicate" && row.duplicate_of !== undefined) {
    detail =
      `<a href="#csv-row-${String(row.duplicate_of)}">` +
      `${escapeHtml(resolveCaption(DUPLICATE_OF, context))} ${String(row.duplicate_of)}</a>`;
  }
  return (
    `<tr id="${escapeAttr(anchor)}">` +
    `<td>${select}</td>` +
    `<td>${String(row.index)}</td>` +
    `<td>${escapeHtml(statusText)}</td>` +
    `<td>${renderInputsList(row.inputs)}</td>` +
    `<td>${detail}</td></tr>`
  );
}

/**
 * Render one review with its commit form: counts, consent echo, every
 * row preserved, valid rows preselected with render-minted replay
 * keys. The host submits the commit form via `submitCsvCommit`
 * (confirm.ts) and swaps the outcome into its own region.
 */
export async function csvPreviewSection(props: CsvPreviewProps): Promise<string> {
  if (typeof props.commitPath !== "string" || props.commitPath.trim() === "") {
    throw new Error("csvPreviewSection needs a non-empty commitPath");
  }
  if (typeof props.csvText !== "string" || props.csvText === "") {
    throw new Error("csvPreviewSection needs the echoed CSV text");
  }
  assertRegionId(props.regionId);
  const review = props.review;
  const countsLine =
    `<p><strong>${String(review.counts.total)}</strong> ` +
    `${escapeHtml(resolveCaption(COUNT_ROWS, props.context))} · ` +
    `<strong>${String(review.counts.valid)}</strong> ` +
    `${escapeHtml(resolveCaption(COUNT_VALID, props.context))} · ` +
    `<strong>${String(review.counts.invalid)}</strong> ` +
    `${escapeHtml(resolveCaption(COUNT_INVALID, props.context))} · ` +
    `<strong>${String(review.counts.duplicate)}</strong> ` +
    `${escapeHtml(resolveCaption(COUNT_DUPLICATE, props.context))}</p>`;
  const consentLine =
    `<p>${escapeHtml(resolveCaption(CONSENT_REVIEW, props.context))} ` +
    `<code>${escapeHtml(review.review_id)}</code> · ` +
    `<strong>${String(review.consent.candidate_count)}</strong> ` +
    `${escapeHtml(resolveCaption(CONSENT_CANDIDATES, props.context))} · ` +
    `${escapeHtml(resolveCaption(CONSENT_DIGEST, props.context))} ` +
    `<code title="${escapeAttr(review.consent.candidates_digest)}">` +
    `${escapeHtml(review.consent.candidates_digest.slice(0, 16))}</code></p>`;
  const renewal =
    props.renewal === undefined
      ? ""
      : `<p role="alert"><a href="${escapeAttr(props.renewal.href)}">` +
        `${escapeHtml(resolveCaption(props.renewal.notice, props.context))}</a></p>`;
  const head =
    `<tr><th scope="col">${escapeHtml(resolveCaption(COL_SELECT, props.context))}</th>` +
    `<th scope="col">${escapeHtml(resolveCaption(COL_ROW, props.context))}</th>` +
    `<th scope="col">${escapeHtml(resolveCaption(COL_STATUS, props.context))}</th>` +
    `<th scope="col">${escapeHtml(resolveCaption(COL_INPUTS, props.context))}</th>` +
    `<th scope="col">${escapeHtml(resolveCaption(COL_DETAIL, props.context))}</th></tr>`;
  const body = review.rows
    .map((row) =>
      renderPreviewRow(
        row,
        props.context,
        row.status === "valid" ? mintOperationId() : null,
      ),
    )
    .join("");
  const commitForm =
    review.counts.valid === 0
      ? `<p>${escapeHtml(resolveCaption(NO_VALID_ROWS, props.context))}</p>`
      : `<form action="${escapeAttr(props.commitPath)}" method="post" ` +
        `data-csv-commit-form="${escapeAttr(props.regionId)}">` +
        `<input type="hidden" name="${escapeAttr(CSRF_FIELD)}" value="${escapeAttr(props.context.csrfToken)}">` +
        `<input type="hidden" name="operation" value="${escapeAttr(review.operation)}">` +
        `<input type="hidden" name="csv" value="${escapeAttr(props.csvText)}">` +
        `<input type="hidden" name="consent.review_id" value="${escapeAttr(review.consent.review_id)}">` +
        `<input type="hidden" name="consent.operation" value="${escapeAttr(review.consent.operation)}">` +
        `<input type="hidden" name="consent.principal" value="${escapeAttr(review.consent.principal)}">` +
        `<input type="hidden" name="consent.candidates_digest" value="${escapeAttr(review.consent.candidates_digest)}">` +
        `<input type="hidden" name="consent.candidate_count" value="${String(review.consent.candidate_count)}">` +
        `<table class="table"><thead>${head}</thead><tbody>${body}</tbody></table>` +
        `<button type="submit" class="btn btn-primary">` +
        `${escapeHtml(resolveCaption(COMMIT_SUBMIT, props.context))}</button></form>`;
  const inner =
    `<h3>${escapeHtml(resolveCaption(PREVIEW_HEADING, props.context))}</h3>` +
    countsLine +
    consentLine +
    renewal +
    (review.counts.valid === 0
      ? `<table class="table"><thead>${head}</thead><tbody>${body}</tbody></table>` + commitForm
      : commitForm);
  return fragmentRegion({
    regionId: props.regionId,
    label: PREVIEW_HEADING,
    context: props.context,
    content: [inner],
  });
}

export interface SubmitCsvReviewInput {
  readonly fetchImpl: SubmitFetch;
  /** Review POST path supplied by the caller; never invented here. */
  readonly action: string;
  readonly csrf: string;
  readonly operation: string;
  readonly csv: string;
}

export type SubmitCsvReviewResult =
  | { readonly ok: true; readonly review: CsvReviewModel }
  | { readonly ok: false; readonly error: CsvBusinessError };

function transportError(message: string): CsvBusinessError {
  return { code: "transport", message };
}

/**
 * POST one review request as JSON with the CSRF header. Server error
 * bodies digest to `CsvBusinessError`; transport failures become
 * `{code:'transport'}`. A malformed success body throws (contract
 * violation — host-fatal).
 */
export async function submitCsvReview(input: SubmitCsvReviewInput): Promise<SubmitCsvReviewResult> {
  if (typeof input.action !== "string" || input.action === "") {
    throw new Error("submitCsvReview needs a non-empty action");
  }
  if (typeof input.csrf !== "string" || input.csrf === "") {
    throw new Error("submitCsvReview needs the CSRF token");
  }
  if (typeof input.operation !== "string" || input.operation === "") {
    throw new Error("submitCsvReview needs the operation");
  }
  if (typeof input.csv !== "string" || input.csv === "") {
    throw new Error("submitCsvReview needs the CSV text");
  }
  let response: SubmitFetchResponse;
  try {
    response = await input.fetchImpl(input.action, {
      method: "POST",
      headers: { "content-type": "application/json", [CSV_CSRF_HEADER]: input.csrf },
      body: JSON.stringify({ operation: input.operation, csv: input.csv }),
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    return { ok: false, error: transportError(`Review request failed: ${messageText}`) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    return { ok: false, error: transportError(`Review request failed (status ${String(response.status)}).`) };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, error: digestBusinessError(parsed) ?? transportError(`Review request failed (status ${String(response.status)}).`) };
  }
  return { ok: true, review: parseReviewPayload(parsed) };
}
