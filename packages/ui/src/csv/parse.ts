/**
 * FP.CSV UI third 1/3: CSV intake parsing + review-request form.
 *
 * `parseCsvText` is an ADVISORY client-side parse (instant feedback: row
 * count, header echo, malformed flags). The server re-parses
 * authoritatively on every review/commit (`parseCsvText` in
 * interfaces/src/http/csv.ts) and never trusts this output, so a
 * client/server skew can only cost a round trip, never correctness.
 * Grammar mirror: comma-separated, CRLF/LF newlines, double-quote
 * quoting with `""` escapes (quotes may span lines), lone CR literal,
 * blank lines preserved as single-empty-field records (flagged
 * `malformed` against multi-column headers — this mirrors the server
 * implementation, whose doc comment says "skipped" but whose
 * recordHadChars handling preserves), field-count mismatches flagged
 * `malformed` and preserved. The 1000-row ceiling pins the server
 * `CSV_MAX_ROWS` (DoS hygiene; the 1 MiB body cap bounds bytes).
 *
 * `csvReviewForm` renders the review-request form: caller-supplied
 * operation list + review path (never invented here), CSV textarea,
 * CSRF hidden field, and stable ids the host wires to
 * `submitCsvReview` (preview.ts) — the sibling submit helper POSTs
 * JSON because the CSV endpoints require a JSON content type, which
 * plain forms and hx-post cannot send.
 *
 * This module also owns the thirds' shared view-model guards:
 * `CsvBusinessError` digests server error JSON ({code,message,
 * fields?,retryable?}); UI never renders raw server bodies.
 */

import type {
  MessageValue,
  PresentationContext,
} from "@canlang/contracts";
import { CSRF_FIELD } from "@canlang/contracts";
import { escapeAttr, escapeHtml } from "../escape.js";
import { assertRegionId } from "../htmx.js";
import { message, resolveCaption } from "../messages.js";

/** Row ceiling per review/commit. Pins server CSV_MAX_ROWS (interfaces csv.ts). */
export const CSV_UI_MAX_ROWS = 1000;

/**
 * Session CSRF header spelling. Pins the identity-owned spelling the
 * dispatcher asserts (`x-csrf-token`; client.ts carries the same local
 * spelling, which this scope must not touch to re-export).
 */
export const CSV_CSRF_HEADER = "x-csrf-token";

/** Server error digest: code + safe message + optional field errors. */
export interface CsvBusinessError {
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
export function digestBusinessError(value: unknown): CsvBusinessError | null {
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

/** One advisory parsed data row: raw cell strings + field-count flag. */
export interface CsvClientRow {
  readonly cells: readonly string[];
  readonly malformed: boolean;
}

/** Advisory parse outcome. Content failures are data, never throws. */
export type CsvClientParse =
  | { readonly ok: true; readonly header: readonly string[]; readonly rows: ReadonlyArray<CsvClientRow> }
  | { readonly ok: false; readonly error: { readonly kind: "parse" | "limit"; readonly message: string } };

/**
 * Parse CSV text for instant intake feedback. Returns row structure;
 * user-content failures (unterminated quote, missing header, row
 * ceiling) return `{ok:false}` — only a non-string argument (programmer
 * misuse) throws.
 */
export function parseCsvText(text: string): CsvClientParse {
  if (typeof text !== "string") {
    throw new Error("parseCsvText needs CSV text");
  }
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let recordHadChars = false;
  const endField = (): void => {
    record.push(field);
    field = "";
  };
  const endRecord = (): void => {
    endField();
    if (recordHadChars) records.push(record);
    record = [];
    recordHadChars = false;
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    recordHadChars = true;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += char;
        i += 1;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i += 1;
    } else if (char === ",") {
      endField();
      i += 1;
    } else if (char === "\n") {
      endRecord();
      i += 1;
    } else if (char === "\r" && text[i + 1] === "\n") {
      endRecord();
      i += 2;
    } else {
      field += char;
      i += 1;
    }
  }
  if (inQuotes) {
    return { ok: false, error: { kind: "parse", message: "Unterminated quoted field in CSV text." } };
  }
  endRecord();
  if (records.length === 0) {
    return { ok: false, error: { kind: "parse", message: "CSV text has no header row." } };
  }
  const header = records[0] as string[];
  const data = records.slice(1);
  if (data.length > CSV_UI_MAX_ROWS) {
    return {
      ok: false,
      error: {
        kind: "limit",
        message: `CSV text has ${String(data.length)} data rows; the limit is ${String(CSV_UI_MAX_ROWS)}.`,
      },
    };
  }
  return {
    ok: true,
    header,
    rows: data.map((cells) => ({ cells, malformed: cells.length !== header.length })),
  };
}

const REVIEW_HEADING = message("Review CSV intake", { nl: "CSV-intake beoordelen" });
const OPERATION_LABEL = message("Operation", { nl: "Bewerking" });
const CSV_LABEL = message("CSV text", { nl: "CSV-tekst" });
const REVIEW_SUBMIT = message("Review rows", { nl: "Rijen beoordelen" });

/** Consent-renewal hook: notice + caller-supplied re-review target. */
export interface CsvRenewalHook {
  readonly notice: MessageValue;
  /** Re-review target path supplied by the caller; never invented here. */
  readonly href: string;
}

/** One caller-authorized operation the review form may target. */
export interface CsvOperationChoice {
  readonly name: string;
  readonly caption: MessageValue;
}

export interface CsvReviewFormProps {
  readonly context: PresentationContext;
  /** Review POST path supplied by the caller; never invented here. */
  readonly reviewPath: string;
  /** Preview region id the host swaps the review into. */
  readonly regionId: string;
  /** Caller-authorized operations (nonempty). */
  readonly operations: ReadonlyArray<CsvOperationChoice>;
}

/**
 * Review-request form: operation picker, CSV textarea, CSRF hidden
 * field. The host submits via `submitCsvReview` (JSON transport) and
 * swaps the rendered preview into `regionId`.
 */
export async function csvReviewForm(props: CsvReviewFormProps): Promise<string> {
  if (typeof props.reviewPath !== "string" || props.reviewPath.trim() === "") {
    throw new Error("csvReviewForm needs a non-empty reviewPath");
  }
  assertRegionId(props.regionId);
  if (!Array.isArray(props.operations) || props.operations.length === 0) {
    throw new Error("csvReviewForm needs at least one operation");
  }
  const options: string[] = [];
  for (const choice of props.operations) {
    if (typeof choice.name !== "string" || choice.name === "") {
      throw new Error("csvReviewForm operation names must be non-empty strings");
    }
    options.push(
      `<option value="${escapeAttr(choice.name)}">${escapeHtml(resolveCaption(choice.caption, props.context))}</option>`,
    );
  }
  const formId = `${props.regionId}-form`;
  return (
    `<section><h2>${escapeHtml(resolveCaption(REVIEW_HEADING, props.context))}</h2>` +
    `<form id="${escapeAttr(formId)}" action="${escapeAttr(props.reviewPath)}" method="post" ` +
    `data-csv-review-form="${escapeAttr(props.regionId)}">` +
    `<input type="hidden" name="${escapeAttr(CSRF_FIELD)}" value="${escapeAttr(props.context.csrfToken)}">` +
    `<label>${escapeHtml(resolveCaption(OPERATION_LABEL, props.context))}` +
    `<select name="operation" required>${options.join("")}</select></label>` +
    `<label>${escapeHtml(resolveCaption(CSV_LABEL, props.context))}` +
    `<textarea name="csv" rows="10" required></textarea></label>` +
    `<button type="submit" class="btn btn-primary">${escapeHtml(resolveCaption(REVIEW_SUBMIT, props.context))}</button>` +
    `</form></section>`
  );
}
