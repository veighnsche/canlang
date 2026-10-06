/**
 * Browser error capture for FP.INSTRUMENTATION (CanCatch intake).
 *
 * Produces exactly E's landed v1 report body
 * (`interfaces/src/instrumentation/intake.ts`, `admitIntakeReport`):
 * `{version:1, id, occurred_at, message, stack?, environment?,
 * release?, fingerprint?}` — closed member set, no envelope
 * invention here. The caller owns the intake action URL (pinned
 * server route `POST /errors/{key}`; never invented here) and the
 * intake key stays a public write-only identifier: capture sends
 * reports only and can never nominate a project, quota, grouping
 * version, viewer, or health authority (any such member would fail
 * E's closed-member admission).
 *
 * Capture is nonblocking and recursion-free by construction: build
 * failures throw a typed input error before any fetch exists, and
 * this module has no failure-reporting hook, so a report can never
 * report itself. Client-side bounds mirror E's pinned admission
 * bounds (message 4096 chars, stack 32000 chars); over-bound text
 * truncates deterministically so capture never sends a doomed
 * report. Occurrence-window checks stay server-side (clock
 * authority); the client only requires a parseable instant.
 *
 * No CSRF header: intake keys are the admission credential
 * (CanCatch: reporting clients hold intake-only configuration and
 * never gain team administration or read access through a browser
 * key), and E's intake asserts no CSRF header.
 */
import type { SubmitFetch, SubmitFetchResponse } from "../client.js";

/** Intake v1 report version (E-pinned; the only admitted version). */
export const CAPTURE_INTAKE_VERSION = 1;

/** Normalized message bound in chars (mirrors E's admission bound). */
export const CAPTURE_MESSAGE_MAX_CHARS = 4_096;

/** Stack bound in chars (mirrors E's admission bound). */
export const CAPTURE_STACK_MAX_CHARS = 32_000;

/** Truncation marker appended to over-bound text (counts toward the bound). */
export const CAPTURE_TRUNCATION_MARKER = "…[truncated]";

/** Typed capture input failure: programmer error, thrown before any fetch. */
export class CaptureInputError extends Error {
  constructor(message: string) {
    super(`capture error report: ${message}`);
    this.name = "CaptureInputError";
  }
}

/** Exact v1 report body (E's closed member set — no other members ever sent). */
export interface ErrorReportBody {
  readonly version: 1;
  readonly id: string;
  readonly occurred_at: string;
  readonly message: string;
  readonly stack?: string;
  readonly environment?: string;
  readonly release?: string;
  readonly fingerprint?: string;
}

/** Fields the caller supplies; bounds truncate, missing/invalid throw. */
export interface BuildErrorReportInput {
  readonly id: string;
  /** ISO instant of occurrence (must Date.parse; window checks are server-side). */
  readonly occurredAt: string;
  readonly message: string;
  readonly stack?: string;
  readonly environment?: string;
  readonly release?: string;
  readonly fingerprint?: string;
}

function truncateTo(text: string, bound: number): string {
  if (text.length <= bound) {
    return text;
  }
  return text.slice(0, bound - CAPTURE_TRUNCATION_MARKER.length) + CAPTURE_TRUNCATION_MARKER;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new CaptureInputError(`report ${field} must be a non-empty string when present`);
  }
  return value;
}

/**
 * Build one v1 report body. Pure: id/message/occurred_at must be
 * present and well-typed (typed throw otherwise); message/stack
 * truncate to E's bounds; optional members pass through verbatim
 * when present. The result holds exactly the admitted members.
 */
export function buildErrorReportBody(input: BuildErrorReportInput): ErrorReportBody {
  if (typeof input.id !== "string" || input.id.length === 0) {
    throw new CaptureInputError("report needs a non-empty id");
  }
  if (typeof input.occurredAt !== "string" || !Number.isFinite(Date.parse(input.occurredAt))) {
    throw new CaptureInputError("report occurredAt must be a parseable instant");
  }
  if (typeof input.message !== "string" || input.message.length === 0) {
    throw new CaptureInputError("report needs a non-empty message");
  }
  const stack = optionalText(input.stack, "stack");
  const environment = optionalText(input.environment, "environment");
  const release = optionalText(input.release, "release");
  const fingerprint = optionalText(input.fingerprint, "fingerprint");
  return {
    version: CAPTURE_INTAKE_VERSION,
    id: input.id,
    occurred_at: input.occurredAt,
    message: truncateTo(input.message, CAPTURE_MESSAGE_MAX_CHARS),
    ...(stack === undefined ? {} : { stack: truncateTo(stack, CAPTURE_STACK_MAX_CHARS) }),
    ...(environment === undefined ? {} : { environment }),
    ...(release === undefined ? {} : { release }),
    ...(fingerprint === undefined ? {} : { fingerprint }),
  };
}

/** Capture failure: server denial code, or `transport` for fetch/parse failure. */
export interface CaptureReportError {
  readonly code: string;
  readonly message: string;
}

export type SubmitErrorReportResult =
  | { readonly ok: true; readonly reference: string }
  | { readonly ok: false; readonly error: CaptureReportError };

export interface SubmitErrorReportInput {
  readonly fetchImpl: SubmitFetch;
  /** Intake POST action supplied by the caller; never invented here. */
  readonly action: string;
  readonly report: ErrorReportBody;
}

function transportError(message: string): CaptureReportError {
  return { code: "transport", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * POST one report body as JSON to the caller-supplied intake action.
 * 202 `{reference}` resolves ok; any other status digests the
 * business-error body when parseable (code/message passthrough, so
 * `forbidden`/`limit`/`validation` survive honestly); transport
 * throws and unparseable bodies map to `{code:'transport'}`.
 * Malformed 202 bodies throw (contract violation — host-fatal).
 */
export async function submitErrorReport(
  input: SubmitErrorReportInput,
): Promise<SubmitErrorReportResult> {
  if (typeof input.action !== "string" || input.action === "") {
    throw new Error("submitErrorReport needs a non-empty action");
  }
  let response: SubmitFetchResponse;
  try {
    response = await input.fetchImpl(input.action, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.report),
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    return { ok: false, error: transportError(`Error report failed: ${messageText}`) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    return {
      ok: false,
      error: transportError(`Error report failed (status ${String(response.status)}).`),
    };
  }
  if (response.status === 202) {
    if (!isRecord(parsed) || typeof parsed["reference"] !== "string") {
      throw new Error("submitErrorReport: intake 202 body is not a {reference} envelope");
    }
    return { ok: true, reference: parsed["reference"] };
  }
  if (isRecord(parsed) && typeof parsed["code"] === "string") {
    return {
      ok: false,
      error: {
        code: parsed["code"],
        message: typeof parsed["message"] === "string" ? parsed["message"] : "",
      },
    };
  }
  return {
    ok: false,
    error: transportError(`Error report failed (status ${String(response.status)}).`),
  };
}
