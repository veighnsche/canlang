/**
 * FP.EXPORT browser-consumer pins (export): the browser slice reads the
 * released HTTP export contract (`interfaces/src/http/export.ts`,
 * c1dcc1a) without re-implementing it.
 *
 * - Authenticated CSV request/result preserved: the POST carries the
 *   caller action + CSRF header + declared operation/columns/limit;
 *   the inline CSV returns byte-exact (server neutralization and
 *   quoting untouched — the consumer never strips or re-protects).
 * - No false completion: only `complete && !truncated` derives
 *   `inline-complete`; a descriptor (pending/expired) never completes,
 *   contradictory flags fail toward pending, and
 *   `downloadInlineCsv` refuses anything but inline-complete.
 * - Explicit pending/expiry/download/error/cancel: truncated outcomes
 *   render pending with guarded expiry + safe D-owned links and never
 *   fetch status/download URLs (exactly one fetch per request — no
 *   invented polling); expired descriptors lose their links; server
 *   errors digest (never raw bodies); transport throws and unparseable
 *   bodies map to transport; parsed-but-malformed success bodies throw
 *   (contract violation, host-fatal); a cancelled
 *   controller fails fast and ignores late responses.
 * - Filename/security limits: download names sanitize
 *   (path/extension/length capped, forced `.csv`); all rendered
 *   strings escape; all hrefs pass `safeHref`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SubmitFetchResponse } from "../src/client.js";
import {
  createExportController,
  deriveExportStatus,
  digestExportError,
  downloadInlineCsv,
  exportFilename,
  isDescriptorExpired,
  parseExportPayload,
  renderExportPanel,
  submitExportRequest,
} from "../src/browser/export.js";
import type { DownloadSink, ExportDescriptorModel } from "../src/browser/export.js";
import { loadHtml } from "./harness.js";

const ACTION = "/api/exports";
const CSRF = "csrf-token";
const OPERATION = "Billing.Invoice.list";

function stubResponse(status: number, body: string, contentType = "application/json"): SubmitFetchResponse {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  };
}

const INLINE = {
  operation: OPERATION,
  as_of: "2026-10-06T12:00:00.000Z",
  complete: true,
  row_count: 2,
  truncated: false,
  columns: [
    { field: "id", label: "ID" },
    { field: "version", label: "Version" },
    { field: "customer", label: "Customer" },
  ],
  csv: "id,version,customer\ninv-1,3,'=1+1\ninv-2,,\"Oaks, \"\"Fine\"\"\"\n",
};

const DESCRIPTOR: ExportDescriptorModel = {
  handle: "exp-0123456789abcdef",
  status: "pending",
  download_url: "https://app.invalid/api/exports/download/exp-0123456789abcdef",
  status_url: "https://app.invalid/api/exports/status/exp-0123456789abcdef",
  expires_at: "2099-01-01T00:15:00.000Z",
  row_estimate: null,
  truncated: true,
};

const TRUNCATED = {
  ...INLINE,
  complete: false,
  truncated: true,
  next_cursor: "cur-9",
  descriptor: DESCRIPTOR,
};

test("browser-export: authenticated request preserves the inline CSV byte-exact", async () => {
  const calls: Array<{ url: string; init: unknown }> = [];
  const result = await submitExportRequest({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return stubResponse(200, JSON.stringify(INLINE));
    },
    action: ACTION,
    csrf: CSRF,
    operation: OPERATION,
    columns: ["customer"],
    limit: 10,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, ACTION);
  const init = calls[0]!.init as { method: string; headers: Record<string, string>; body: string };
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-type"], "application/json");
  assert.equal(init.headers["x-csrf-token"], CSRF);
  assert.deepEqual(JSON.parse(init.body), { operation: OPERATION, columns: ["customer"], limit: 10 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outcome.csv, INLINE.csv);
  assert.equal(deriveExportStatus(result.outcome, Date.parse("2026-10-06T12:00:00.000Z")), "inline-complete");
});

test("browser-export: descriptor alone never completes; contradictions fail toward pending", () => {
  const now = Date.parse("2026-10-06T12:00:00.000Z");
  assert.equal(deriveExportStatus(parseExportPayload(INLINE), now), "inline-complete");
  assert.equal(deriveExportStatus(parseExportPayload(TRUNCATED), now), "truncated-pending");
  /* Contradictory flags fail toward not-complete. */
  assert.equal(
    deriveExportStatus(parseExportPayload({ ...TRUNCATED, complete: true }), now),
    "truncated-pending",
  );
  /* Truncated without a descriptor violates the contract (host-fatal). */
  const { descriptor: _dropped, ...noDescriptor } = TRUNCATED;
  void _dropped;
  assert.throws(() => parseExportPayload(noDescriptor), /descriptor/);
  /* Malformed payloads throw rather than render. */
  assert.throws(() => parseExportPayload({ operation: OPERATION }), /as_of/);
});

test("browser-export: expiry is explicit and fail-closed; expired links die", () => {
  assert.equal(isDescriptorExpired(DESCRIPTOR, Date.parse("2026-10-06T12:00:00.000Z")), false);
  assert.equal(isDescriptorExpired(DESCRIPTOR, Date.parse("2099-06-01T00:00:00.000Z")), true);
  assert.equal(isDescriptorExpired({ ...DESCRIPTOR, expires_at: "not-a-date" }, 0), true);
  const expired = parseExportPayload({
    ...TRUNCATED,
    descriptor: { ...DESCRIPTOR, expires_at: "2020-01-01T00:00:00.000Z" },
  });
  assert.equal(deriveExportStatus(expired, Date.parse("2026-10-06T12:00:00.000Z")), "expired");
  const html = renderExportPanel({
    regionId: "export-result",
    action: ACTION,
    csrf: CSRF,
    operations: [OPERATION],
    status: { kind: "expired", outcome: expired },
  });
  assert.ok(!html.includes(DESCRIPTOR.download_url));
  assert.match(html, /expired/i);
});

test("browser-export: pending renders guarded links and never polls status/download", async () => {
  const calls: string[] = [];
  const result = await submitExportRequest({
    fetchImpl: async (url) => {
      calls.push(url);
      return stubResponse(200, JSON.stringify(TRUNCATED));
    },
    action: ACTION,
    csrf: CSRF,
    operation: OPERATION,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  /* Exactly one fetch: the consumer never touches status/download URLs. */
  assert.deepEqual(calls, [ACTION]);
  const html = renderExportPanel({
    regionId: "export-result",
    action: ACTION,
    csrf: CSRF,
    operations: [OPERATION],
    status: { kind: "truncated-pending", outcome: result.outcome },
  });
  const page = await loadHtml(html);
  try {
    const anchors = Array.from(page.document.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
    assert.ok(anchors.includes(DESCRIPTOR.download_url));
    assert.ok(anchors.includes(DESCRIPTOR.status_url));
    assert.match(page.document.body.textContent ?? "", /pending/i);
    assert.match(page.document.body.textContent ?? "", /does not poll|no automatic refresh/i);
  } finally {
    await page.close();
  }
});

test("browser-export: download takes inline-complete only, with sanitized filenames", () => {
  const saved: Array<{ filename: string; text: string; mime: string }> = [];
  const sink: DownloadSink = {
    save: (filename, text, mime) => {
      saved.push({ filename, text, mime });
    },
  };
  const outcome = parseExportPayload(INLINE);
  const filename = downloadInlineCsv(sink, outcome, Date.parse("2026-10-06T12:00:00.000Z"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.text, INLINE.csv);
  assert.equal(saved[0]!.mime, "text/csv;charset=utf-8");
  assert.equal(saved[0]!.filename, filename);
  assert.match(filename, /\.csv$/);
  /* Descriptor-only outcomes refuse download (no false completion). */
  assert.throws(
    () => downloadInlineCsv(sink, parseExportPayload(TRUNCATED), Date.parse("2026-10-06T12:00:00.000Z")),
    /inline-complete/,
  );
  assert.equal(saved.length, 1);
  /* Filename limits: traversal, separators, length, suffix. */
  assert.equal(exportFilename("../../etc/passwd", INLINE.as_of), "etc-passwd-20261006.csv");
  assert.equal(exportFilename("Billing.Invoice.list", "not-a-date"), "Billing.Invoice.list-nodate.csv");
  const long = exportFilename("o".repeat(200), INLINE.as_of);
  assert.ok(long.length <= 80 && long.endsWith(".csv"));
});

test("browser-export: errors digest safely; transport and contract faults stay explicit", async () => {
  const denied = await submitExportRequest({
    fetchImpl: async () => stubResponse(403, JSON.stringify({ code: "forbidden", message: "<script>x</script>" })),
    action: ACTION,
    csrf: CSRF,
    operation: OPERATION,
  });
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.deepEqual(denied.error, { code: "forbidden", message: "<script>x</script>" });
  const html = renderExportPanel({
    regionId: "export-result",
    action: ACTION,
    csrf: CSRF,
    operations: [OPERATION],
    status: { kind: "failed", error: denied.error },
  });
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  const transport = await submitExportRequest({
    fetchImpl: async () => {
      throw new Error("boom");
    },
    action: ACTION,
    csrf: CSRF,
    operation: OPERATION,
  });
  assert.equal(transport.ok, false);
  if (transport.ok) return;
  assert.equal(transport.error.code, "transport");
  /* Unparseable bodies are transport faults (possibly truncated bytes). */
  const garbled = await submitExportRequest({
    fetchImpl: async () => stubResponse(200, "not json"),
    action: ACTION,
    csrf: CSRF,
    operation: OPERATION,
  });
  assert.equal(garbled.ok, false);
  if (garbled.ok) return;
  assert.equal(garbled.error.code, "transport");
  /* Parsed-but-malformed success bodies throw (contract violation, host-fatal). */
  await assert.rejects(
    submitExportRequest({
      fetchImpl: async () => stubResponse(200, JSON.stringify({ operation: OPERATION })),
      action: ACTION,
      csrf: CSRF,
      operation: OPERATION,
    }),
    /as_of/,
  );
  assert.equal(digestExportError({ code: "", message: "" }), null);
  assert.equal(digestExportError(null), null);
});

test("browser-export: cancel fails fast and ignores late responses", async () => {
  const controller = createExportController();
  controller.cancel();
  let fetches = 0;
  const early = await submitExportRequest({
    fetchImpl: async () => {
      fetches += 1;
      return stubResponse(200, JSON.stringify(INLINE));
    },
    action: ACTION,
    csrf: CSRF,
    operation: OPERATION,
    controller,
  });
  assert.equal(early.ok, false);
  if (early.ok) return;
  assert.equal(early.error.code, "cancelled");
  assert.equal(fetches, 0);
  /* Late cancel (after settle started) still reports cancelled, not success. */
  const racing = createExportController();
  const late = await submitExportRequest({
    fetchImpl: async () => {
      racing.cancel();
      return stubResponse(200, JSON.stringify(INLINE));
    },
    action: ACTION,
    csrf: CSRF,
    operation: OPERATION,
    controller: racing,
  });
  assert.equal(late.ok, false);
  if (late.ok) return;
  assert.equal(late.error.code, "cancelled");
});

test("browser-export: initial panel renders the declared form with stable wiring ids", async () => {
  const html = renderExportPanel({
    regionId: "export-panel",
    action: ACTION,
    csrf: CSRF,
    operations: [OPERATION, "Shop.Order.list"],
  });
  const page = await loadHtml(html);
  try {
    const section = page.document.querySelector("section#export-panel");
    assert.ok(section !== null);
    assert.equal(section?.getAttribute("data-export-action"), ACTION);
    const options = Array.from(page.document.querySelectorAll("select option")).map((o) => o.getAttribute("value"));
    assert.deepEqual(options, [OPERATION, "Shop.Order.list"]);
    assert.ok(page.document.querySelector('[data-export-result]') !== null);
    assert.ok(page.document.querySelector('[data-export-download]') === null);
  } finally {
    await page.close();
  }
  /* Region ids validate (host-misuse fails closed). */
  assert.throws(
    () => renderExportPanel({ regionId: "has space", action: ACTION, csrf: CSRF, operations: [OPERATION] }),
    /region/,
  );
});
