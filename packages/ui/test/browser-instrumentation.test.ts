/**
 * FP.INSTRUMENTATION browser-consumer pins (error capture): the browser
 * slice produces exactly E's landed v1 report body
 * (`interfaces/src/instrumentation/intake.ts`, `admitIntakeReport`)
 * and POSTs it to the caller-owned intake action — no envelope
 * invention, no member beyond the closed admitted set.
 *
 * - Exact closed shape: version/id/occurred_at/message plus only the
 *   supplied optionals; over-bound message/stack truncate to E's
 *   pinned bounds; missing/invalid id/message/occurred_at throw a
 *   typed input error before any fetch exists (never a doomed send).
 * - Honest submit: 202 `{reference}` resolves ok; denials digest
 *   code/message passthrough (`forbidden`/`limit`/`validation`
 *   survive); transport throws and unparseable bodies map to
 *   transport; malformed 202 bodies throw (contract violation,
 *   host-fatal). Exactly one fetch per request; no CSRF header
 *   (intake keys are the admission credential).
 * - No reporter recursion: build failures throw before fetch (the
 *   stub records zero calls), and the module has no
 *   failure-reporting hook, so a report can never report itself.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SubmitFetch, SubmitFetchResponse } from "../src/client.js";
import {
  buildErrorReportBody,
  CAPTURE_INTAKE_VERSION,
  CAPTURE_MESSAGE_MAX_CHARS,
  CAPTURE_STACK_MAX_CHARS,
  CAPTURE_TRUNCATION_MARKER,
  CaptureInputError,
  submitErrorReport,
} from "../src/browser/instrumentation.js";

const ACTION = "/errors/intake-key-1";
const OCCURRED = "2026-10-06T12:00:00.000Z";

function stubResponse(status: number, body: string): SubmitFetchResponse {
  return {
    status,
    headers: { get: () => "application/json" },
    text: async () => body,
  };
}

function recordingFetch(respond: () => SubmitFetchResponse): {
  fetchImpl: SubmitFetch;
  calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body?: unknown } }>;
} {
  const calls: Array<{
    url: string;
    init: { method: string; headers: Record<string, string>; body?: unknown };
  }> = [];
  return {
    calls,
    fetchImpl: (async (url: string, init) => {
      calls.push({ url, init });
      return respond();
    }) as SubmitFetch,
  };
}

describe("buildErrorReportBody", () => {
  it("builds exactly the closed v1 member set", () => {
    const body = buildErrorReportBody({
      id: "evt-1",
      occurredAt: OCCURRED,
      message: "boom",
      stack: "at f (a.js:1:1)",
      environment: "prod",
      release: "r1",
      fingerprint: "fp-1",
    });
    assert.deepEqual(body, {
      version: 1,
      id: "evt-1",
      occurred_at: OCCURRED,
      message: "boom",
      stack: "at f (a.js:1:1)",
      environment: "prod",
      release: "r1",
      fingerprint: "fp-1",
    });
    assert.equal(CAPTURE_INTAKE_VERSION, 1);
  });

  it("omits absent optionals (never undefined members)", () => {
    const body = buildErrorReportBody({ id: "evt-2", occurredAt: OCCURRED, message: "x" });
    assert.deepEqual(Object.keys(body).sort(), ["id", "message", "occurred_at", "version"]);
  });

  it("truncates over-bound message/stack to E's pinned bounds", () => {
    const body = buildErrorReportBody({
      id: "evt-3",
      occurredAt: OCCURRED,
      message: "m".repeat(CAPTURE_MESSAGE_MAX_CHARS + 100),
      stack: "s".repeat(CAPTURE_STACK_MAX_CHARS + 100),
    });
    assert.equal(body.message.length, CAPTURE_MESSAGE_MAX_CHARS);
    assert.ok(body.message.endsWith(CAPTURE_TRUNCATION_MARKER));
    assert.equal(body.stack?.length, CAPTURE_STACK_MAX_CHARS);
    assert.ok(body.stack?.endsWith(CAPTURE_TRUNCATION_MARKER));
  });

  it("leaves in-bound text byte-exact", () => {
    const message = "m".repeat(CAPTURE_MESSAGE_MAX_CHARS);
    const body = buildErrorReportBody({ id: "evt-4", occurredAt: OCCURRED, message });
    assert.equal(body.message, message);
  });

  it("throws typed input errors before any fetch can exist", () => {
    assert.throws(
      () => buildErrorReportBody({ id: "", occurredAt: OCCURRED, message: "x" }),
      (error: unknown) => error instanceof CaptureInputError,
    );
    assert.throws(
      () => buildErrorReportBody({ id: "a", occurredAt: OCCURRED, message: "" }),
      (error: unknown) => error instanceof CaptureInputError,
    );
    assert.throws(
      () => buildErrorReportBody({ id: "a", occurredAt: "not-an-instant", message: "x" }),
      (error: unknown) => error instanceof CaptureInputError,
    );
    assert.throws(
      () =>
        buildErrorReportBody({ id: "a", occurredAt: OCCURRED, message: "x", environment: "" }),
      (error: unknown) => error instanceof CaptureInputError,
    );
  });
});

describe("submitErrorReport", () => {
  it("POSTs JSON to the caller action; 202 reference resolves ok", async () => {
    const { fetchImpl, calls } = recordingFetch(() => stubResponse(202, `{"reference":"ref-1"}`));
    const report = buildErrorReportBody({ id: "evt-5", occurredAt: OCCURRED, message: "boom" });
    const result = await submitErrorReport({ fetchImpl, action: ACTION, report });
    assert.deepEqual(result, { ok: true, reference: "ref-1" });
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, ACTION);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers["content-type"], "application/json");
    assert.ok(!("x-csrf-token" in call.init.headers), "no CSRF header on intake");
    assert.deepEqual(JSON.parse(call.init.body as string), report);
  });

  it("digests denials with code/message passthrough", async () => {
    for (const [status, code] of [
      [403, "forbidden"],
      [429, "limit"],
      [422, "validation"],
    ] as const) {
      const { fetchImpl } = recordingFetch(() =>
        stubResponse(status, JSON.stringify({ code, message: `${code} happened` })),
      );
      const report = buildErrorReportBody({ id: `evt-${code}`, occurredAt: OCCURRED, message: "x" });
      const result = await submitErrorReport({ fetchImpl, action: ACTION, report });
      assert.deepEqual(result, { ok: false, error: { code, message: `${code} happened` } });
    }
  });

  it("maps transport throws and unparseable bodies to transport", async () => {
    const failing: SubmitFetch = async () => {
      throw new Error("network down");
    };
    const report = buildErrorReportBody({ id: "evt-6", occurredAt: OCCURRED, message: "x" });
    const thrown = await submitErrorReport({ fetchImpl: failing, action: ACTION, report });
    assert.equal(thrown.ok, false);
    assert.ok(thrown.ok === false && thrown.error.code === "transport");

    const { fetchImpl } = recordingFetch(() => stubResponse(202, "not json{{{"));
    const unparseable = await submitErrorReport({ fetchImpl, action: ACTION, report });
    assert.deepEqual(unparseable, {
      ok: false,
      error: { code: "transport", message: "Error report failed (status 202)." },
    });
  });

  it("throws on malformed 202 bodies (contract violation, host-fatal)", async () => {
    const { fetchImpl } = recordingFetch(() => stubResponse(202, `{"nope":true}`));
    const report = buildErrorReportBody({ id: "evt-7", occurredAt: OCCURRED, message: "x" });
    await assert.rejects(
      submitErrorReport({ fetchImpl, action: ACTION, report }),
      (error: unknown) => error instanceof Error && /not a \{reference\} envelope/.test(error.message),
    );
  });

  it("rejects empty actions without fetching", async () => {
    const { fetchImpl, calls } = recordingFetch(() => stubResponse(202, `{"reference":"r"}`));
    const report = buildErrorReportBody({ id: "evt-8", occurredAt: OCCURRED, message: "x" });
    await assert.rejects(submitErrorReport({ fetchImpl, action: "", report }));
    assert.equal(calls.length, 0);
  });
});
