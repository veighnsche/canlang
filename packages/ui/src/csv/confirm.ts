/**
 * FP.CSV UI third 3/3: commit confirmation + per-row outcomes.
 *
 * `csvConfirmSection` renders one server `CsvCommitOutcome` verbatim:
 * frozen commit-time principal, per-row outcomes (committed / failed /
 * invalid-kept / duplicate-pointer), and the partial-failure summary.
 * Row failures are data, so the section always renders — there is no
 * failure page. A `conflict` answer never reaches this renderer (the
 * submit helper returns it as an error); the `renewal` hook renders the
 * consent-renewal notice + caller-supplied re-review target instead.
 *
 * `mintOperationId` mints UUIDv7 replay keys (RFC 9562: 48-bit unix_ms
 * + version nibble + 74 random bits), one per selected row at preview
 * render; replaying an identical commit body re-invokes with
 * byte-identical envelopes because L3 keys idempotency on these ids.
 * Clock and randomness inject for tests; production randomness is
 * `globalThis.crypto.getRandomValues` (a missing implementation is
 * host misuse and throws, mirroring client.ts mint precedent).
 *
 * `collectCommitSelections` reads the preview flat-map contract
 * (`rows[<index>].selected` + `rows[<index>].operation_id`) into
 * typed selections with the server's advisory rules (nonempty,
 * unique indexes/keys). `submitCsvCommit` POSTs
 * `{operation, csv, consent, rows}` as JSON with the CSRF header.
 */

import type { PresentationContext } from "@canlang/contracts";
import type { SubmitFetch, SubmitFetchResponse } from "../client.js";
import {
  csvFormulaProtect,
  escapeAttr,
  escapeHtml,
  isolate,
} from "../escape.js";
import { assertRegionId, fragmentRegion } from "../htmx.js";
import { message, resolveCaption } from "../messages.js";
import type { CsvBusinessError, CsvRenewalHook } from "./parse.js";
import { CSV_CSRF_HEADER, digestBusinessError } from "./parse.js";
import type { CsvConsentModel } from "./preview.js";

/** One commit row selection: review row index + caller replay key. */
export interface CsvCommitSelection {
  readonly index: number;
  readonly operation_id: string;
}

/** Per-row commit outcome, mirroring server CsvCommitRow JSON. */
export type CsvCommitRowStatus = "committed" | "failed" | "invalid" | "duplicate";

export interface CsvCommitRowOutcome {
  readonly index: number;
  readonly operation_id: string;
  readonly status: CsvCommitRowStatus;
  readonly result?: unknown;
  readonly error?: CsvBusinessError;
  readonly duplicate_of?: number;
}

/** Frozen commit-time principal, mirroring the server outcome. */
export interface CsvFrozenPrincipal {
  readonly user_id: string;
  readonly team_id: string | null;
  readonly admitted_at: string;
}

/** Full commit outcome, mirroring server CsvCommitOutcome JSON. */
export interface CsvCommitOutcomeModel {
  readonly operation: string;
  readonly review_id: string;
  readonly principal: CsvFrozenPrincipal;
  readonly rows: ReadonlyArray<CsvCommitRowOutcome>;
}

/**
 * UUIDv7 pattern. Pins the server `UUID_V7_PATTERN`
 * (interfaces/src/envelope/validate.ts) and RFC 9562 §5.11: 48-bit
 * big-endian unix_ms, version nibble `7`, variant `10xx`.
 */
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function defaultClock(): number {
  return Date.now();
}

function defaultRandomBytes(target: Uint8Array): void {
  const crypto = (globalThis as { crypto?: { getRandomValues?: (t: Uint8Array) => void } }).crypto;
  if (typeof crypto?.getRandomValues !== "function") {
    throw new Error("mintOperationId needs crypto.getRandomValues (pass randomBytes)");
  }
  crypto.getRandomValues(target);
}

/**
 * Mint one UUIDv7 `operation_id` replay key. Clock/randomness inject
 * for tests; both default to host time and host crypto.
 */
export function mintOperationId(
  clock: () => number = defaultClock,
  randomBytes: (target: Uint8Array) => void = defaultRandomBytes,
): string {
  const now = Math.floor(clock());
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("mintOperationId needs a nonnegative safe-integer clock");
  }
  const rand = new Uint8Array(10);
  randomBytes(rand);
  const timeHex = now.toString(16).padStart(12, "0").slice(-12);
  const randHex = Array.from(rand, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const ver = `7${randHex.slice(0, 3)}`;
  const variantNibble = (8 + (rand[3] as number % 4)).toString(16);
  const rest = `${variantNibble}${randHex.slice(4, 7)}`;
  const id =
    `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-${ver}-${rest}-${randHex.slice(7, 19)}`;
  if (!UUID_V7_PATTERN.test(id)) {
    throw new Error("mintOperationId minted a non-v7 id");
  }
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function fail(where: string): Error {
  return new Error(`parseCommitPayload: malformed outcome (${where})`);
}

/**
 * Guard server commit-outcome JSON into a renderable model. Throws on
 * malformed bodies (contract violation — host-fatal). Results stay
 * unknown-valued until render armor truncates and escapes them.
 */
export function parseCommitPayload(value: unknown): CsvCommitOutcomeModel {
  if (!isRecord(value)) throw fail("body");
  const operation = value["operation"];
  const review_id = value["review_id"];
  if (typeof operation !== "string" || operation === "") throw fail("operation");
  if (typeof review_id !== "string" || review_id === "") throw fail("review_id");
  const principal = value["principal"];
  if (!isRecord(principal)) throw fail("principal");
  const userId = principal["user_id"];
  const teamId = principal["team_id"];
  const admittedAt = principal["admitted_at"];
  if (typeof userId !== "string" || userId === "") throw fail("principal.user_id");
  if (teamId !== null && typeof teamId !== "string") throw fail("principal.team_id");
  if (typeof admittedAt !== "string" || admittedAt === "") throw fail("principal.admitted_at");
  const rawRows = value["rows"];
  if (!Array.isArray(rawRows)) throw fail("rows");
  const rows: CsvCommitRowOutcome[] = [];
  for (const entry of rawRows) {
    if (!isRecord(entry)) throw fail("rows[]");
    const index = entry["index"];
    const operationId = entry["operation_id"];
    const status = entry["status"];
    if (!isSafeIndex(index)) throw fail("rows[].index");
    if (typeof operationId !== "string" || operationId === "") throw fail("rows[].operation_id");
    if (status !== "committed" && status !== "failed" && status !== "invalid" && status !== "duplicate") {
      throw fail("rows[].status");
    }
    const row: {
      index: number;
      operation_id: string;
      status: CsvCommitRowStatus;
      result?: unknown;
      error?: CsvBusinessError;
      duplicate_of?: number;
    } = { index, operation_id: operationId, status };
    if (entry["result"] !== undefined) row.result = entry["result"];
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
  return {
    operation,
    review_id,
    principal: { user_id: userId, team_id: teamId, admitted_at: admittedAt },
    rows,
  };
}

const SELECTED_KEY = /^rows\[(\d+)\]\.selected$/;
const OPERATION_ID_KEY = /^rows\[(\d+)\]\.operation_id$/;

export type CollectCommitSelectionsResult =
  | { readonly ok: true; readonly selections: ReadonlyArray<CsvCommitSelection> }
  | { readonly ok: false; readonly error: CsvBusinessError };

/**
 * Collect commit selections from the preview flat map (`rows[i]
 * .selected = on` + `rows[i].operation_id`). Empty selection and
 * duplicate replay keys are validation data (the server re-checks
 * authoritatively); non-integer indexes are host misuse and throw.
 */
export function collectCommitSelections(
  flat: Record<string, string>,
): CollectCommitSelectionsResult {
  if (typeof flat !== "object" || flat === null || Array.isArray(flat)) {
    throw new Error("collectCommitSelections needs the preview flat map");
  }
  const selected = new Map<number, string>();
  for (const [key, value] of Object.entries(flat)) {
    const match = SELECTED_KEY.exec(key);
    if (match === null || value !== "on") continue;
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index)) {
      throw new Error(`collectCommitSelections: row index ${JSON.stringify(match[1])} is not a safe integer`);
    }
    const operationId = flat[`rows[${String(index)}].operation_id`];
    if (typeof operationId !== "string" || operationId === "") {
      return {
        ok: false,
        error: { code: "validation", message: `Row ${String(index)} is missing its replay key.` },
      };
    }
    selected.set(index, operationId);
  }
  for (const key of Object.keys(flat)) {
    const match = OPERATION_ID_KEY.exec(key);
    if (match === null) continue;
    if (!Number.isSafeInteger(Number(match[1]))) {
      throw new Error(`collectCommitSelections: row index ${JSON.stringify(match[1])} is not a safe integer`);
    }
  }
  if (selected.size === 0) {
    return { ok: false, error: { code: "validation", message: "Commit selects no rows." } };
  }
  const seen = new Set<string>();
  for (const operationId of selected.values()) {
    if (seen.has(operationId)) {
      return { ok: false, error: { code: "validation", message: "Duplicate operation_id in commit batch." } };
    }
    seen.add(operationId);
  }
  const selections = [...selected.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, operation_id]) => ({ index, operation_id }));
  return { ok: true, selections };
}

const CONFIRM_HEADING = message("CSV commit", { nl: "CSV-vastlegging" });
const PRINCIPAL_LINE = message("Committed by", { nl: "Vastgelegd door" });
const TEAM_LINE = message("team", { nl: "team" });
const REVIEW_LINE = message("Review", { nl: "Beoordeling" });
const COUNT_COMMITTED = message("committed", { nl: "vastgelegd" });
const COUNT_FAILED = message("failed", { nl: "mislukt" });
const COUNT_INVALID = message("invalid", { nl: "ongeldig" });
const COUNT_DUPLICATE = message("duplicate", { nl: "duplicaat" });
const COL_ROW = message("Row", { nl: "Rij" });
const COL_STATUS = message("Status", { nl: "Status" });
const COL_REPLAY_KEY = message("Replay key", { nl: "Replay-sleutel" });
const COL_DETAIL = message("Detail", { nl: "Detail" });
const STATUS_COMMITTED = message("Committed", { nl: "Vastgelegd" });
const STATUS_FAILED = message("Failed", { nl: "Mislukt" });
const STATUS_INVALID = message("Invalid (kept)", { nl: "Ongeldig (behouden)" });
const STATUS_DUPLICATE = message("Duplicate", { nl: "Duplicaat" });
const DUPLICATE_OF = message("duplicate of row", { nl: "duplicaat van rij" });
const NO_RESULT = message("no result", { nl: "geen resultaat" });

/** Rendered result cap: armored JSON past this truncates with an ellipsis. */
const RESULT_PREVIEW_CHARS = 500;

export interface CsvConfirmProps {
  readonly context: PresentationContext;
  readonly outcome: CsvCommitOutcomeModel;
  /** Confirm region id (self) the host swaps outcome HTML into. */
  readonly regionId: string;
  /** Optional consent-renewal notice (conflict path renders notice only). */
  readonly renewal?: CsvRenewalHook;
}

function renderArmoredResult(result: unknown): string {
  if (result === undefined) return "";
  const text = typeof result === "string" ? result : JSON.stringify(result) ?? "null";
  const shown = text.length > RESULT_PREVIEW_CHARS ? `${text.slice(0, RESULT_PREVIEW_CHARS)}…` : text;
  return isolate(escapeHtml(csvFormulaProtect(shown)));
}

function renderRowError(error: CsvBusinessError): string {
  const fields = (error.fields ?? [])
    .map((field) => `<li><code>${escapeHtml(field.path)}</code>: ${escapeHtml(field.message)}</li>`)
    .join("");
  return `<p>${escapeHtml(error.message)}</p>` + (fields === "" ? "" : `<ul>${fields}</ul>`);
}

function renderOutcomeRow(row: CsvCommitRowOutcome, context: PresentationContext): string {
  const statusText =
    row.status === "committed"
      ? resolveCaption(STATUS_COMMITTED, context)
      : row.status === "failed"
        ? resolveCaption(STATUS_FAILED, context)
        : row.status === "invalid"
          ? resolveCaption(STATUS_INVALID, context)
          : resolveCaption(STATUS_DUPLICATE, context);
  let detail = "";
  if (row.status === "committed") {
    detail =
      row.result === undefined
        ? escapeHtml(resolveCaption(NO_RESULT, context))
        : renderArmoredResult(row.result);
  } else if ((row.status === "failed" || row.status === "invalid") && row.error !== undefined) {
    detail = renderRowError(row.error);
  } else if (row.status === "duplicate" && row.duplicate_of !== undefined) {
    detail =
      `${escapeHtml(resolveCaption(DUPLICATE_OF, context))} ${String(row.duplicate_of)}`;
  }
  return (
    `<tr><td>${String(row.index)}</td>` +
    `<td>${escapeHtml(statusText)}</td>` +
    `<td><code title="${escapeAttr(row.operation_id)}">${escapeHtml(row.operation_id.slice(0, 8))}</code></td>` +
    `<td>${detail}</td></tr>`
  );
}

/**
 * Render one commit outcome: frozen principal, per-row outcomes, and
 * the partial-failure summary. With `renewal` set (conflict path),
 * renders the renewal notice instead of outcome rows.
 */
export async function csvConfirmSection(props: CsvConfirmProps): Promise<string> {
  assertRegionId(props.regionId);
  const outcome = props.outcome;
  const renewal =
    props.renewal === undefined
      ? ""
      : `<p role="alert"><a href="${escapeAttr(props.renewal.href)}">` +
        `${escapeHtml(resolveCaption(props.renewal.notice, props.context))}</a></p>`;
  let committed = 0;
  let failed = 0;
  let invalid = 0;
  let duplicate = 0;
  for (const row of outcome.rows) {
    if (row.status === "committed") committed += 1;
    else if (row.status === "failed") failed += 1;
    else if (row.status === "invalid") invalid += 1;
    else duplicate += 1;
  }
  const head =
    `<tr><th scope="col">${escapeHtml(resolveCaption(COL_ROW, props.context))}</th>` +
    `<th scope="col">${escapeHtml(resolveCaption(COL_STATUS, props.context))}</th>` +
    `<th scope="col">${escapeHtml(resolveCaption(COL_REPLAY_KEY, props.context))}</th>` +
    `<th scope="col">${escapeHtml(resolveCaption(COL_DETAIL, props.context))}</th></tr>`;
  const body = outcome.rows.map((row) => renderOutcomeRow(row, props.context)).join("");
  const team = outcome.principal.team_id === null ? "" : ` · ${escapeHtml(resolveCaption(TEAM_LINE, props.context))} ${escapeHtml(outcome.principal.team_id)}`;
  const inner =
    `<h3>${escapeHtml(resolveCaption(CONFIRM_HEADING, props.context))}</h3>` +
    `<p>${escapeHtml(resolveCaption(REVIEW_LINE, props.context))} ` +
    `<code>${escapeHtml(outcome.review_id)}</code></p>` +
    `<p>${escapeHtml(resolveCaption(PRINCIPAL_LINE, props.context))} ` +
    `${escapeHtml(outcome.principal.user_id)}${team}</p>` +
    `<p><strong>${String(committed)}</strong> ` +
    `${escapeHtml(resolveCaption(COUNT_COMMITTED, props.context))} · ` +
    `<strong>${String(failed)}</strong> ` +
    `${escapeHtml(resolveCaption(COUNT_FAILED, props.context))} · ` +
    `<strong>${String(invalid)}</strong> ` +
    `${escapeHtml(resolveCaption(COUNT_INVALID, props.context))} · ` +
    `<strong>${String(duplicate)}</strong> ` +
    `${escapeHtml(resolveCaption(COUNT_DUPLICATE, props.context))}</p>` +
    renewal +
    `<table class="table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  return fragmentRegion({
    regionId: props.regionId,
    label: CONFIRM_HEADING,
    context: props.context,
    content: [inner],
  });
}

export interface SubmitCsvCommitInput {
  readonly fetchImpl: SubmitFetch;
  /** Commit POST path supplied by the caller; never invented here. */
  readonly action: string;
  readonly csrf: string;
  readonly operation: string;
  readonly csv: string;
  readonly consent: CsvConsentModel;
  readonly selections: ReadonlyArray<CsvCommitSelection>;
}

export type SubmitCsvCommitResult =
  | { readonly ok: true; readonly outcome: CsvCommitOutcomeModel }
  | { readonly ok: false; readonly error: CsvBusinessError };

function transportError(messageText: string): CsvBusinessError {
  return { code: "transport", message: messageText };
}

/**
 * POST one commit request as JSON with the CSRF header. Server error
 * bodies (including `conflict` → renewed review required) digest to
 * `CsvBusinessError`; transport failures become `{code:'transport'}`.
 * A malformed success body throws (contract violation — host-fatal).
 */
export async function submitCsvCommit(input: SubmitCsvCommitInput): Promise<SubmitCsvCommitResult> {
  if (typeof input.action !== "string" || input.action === "") {
    throw new Error("submitCsvCommit needs a non-empty action");
  }
  if (typeof input.csrf !== "string" || input.csrf === "") {
    throw new Error("submitCsvCommit needs the CSRF token");
  }
  if (typeof input.operation !== "string" || input.operation === "") {
    throw new Error("submitCsvCommit needs the operation");
  }
  if (typeof input.csv !== "string" || input.csv === "") {
    throw new Error("submitCsvCommit needs the CSV text");
  }
  if (!Array.isArray(input.selections) || input.selections.length === 0) {
    throw new Error("submitCsvCommit needs at least one selection (collect via collectCommitSelections)");
  }
  let response: SubmitFetchResponse;
  try {
    response = await input.fetchImpl(input.action, {
      method: "POST",
      headers: { "content-type": "application/json", [CSV_CSRF_HEADER]: input.csrf },
      body: JSON.stringify({
        operation: input.operation,
        csv: input.csv,
        consent: input.consent,
        rows: input.selections,
      }),
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    return { ok: false, error: transportError(`Commit request failed: ${messageText}`) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    return { ok: false, error: transportError(`Commit request failed (status ${String(response.status)}).`) };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, error: digestBusinessError(parsed) ?? transportError(`Commit request failed (status ${String(response.status)}).`) };
  }
  return { ok: true, outcome: parseCommitPayload(parsed) };
}
