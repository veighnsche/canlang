/**
 * FP.EXPORT browser-consumer pins (print): the browser slice reads the
 * released HTTP Print contract (`interfaces/src/http/print.ts`,
 * c1dcc1a) — declared views only, current grants per open.
 *
 * - Declared views: the caller names a view; names validate
 *   (`^[a-z0-9-]+$`, fail closed — no traversal, no invention) and
 *   the print base path is caller-supplied, never built here.
 * - Current grants: every `fetchPrintView` call issues a live GET
 *   (no caching — revocation between opens denies the next one);
 *   non-HTML answers and error JSON digest explicitly.
 * - Security limits: print URLs pass `safeHref` (unsafe bases fall
 *   back to `#`); the frame render sandboxes scripts out; server HTML
 *   is never inlined into the host page (link/frame only).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SubmitFetchResponse } from "../src/client.js";
import { fetchPrintView, renderPrintFrame, renderPrintLink } from "../src/browser/print.js";
import { loadHtml } from "./harness.js";

const BASE = "https://app.invalid/print";
const VIEW = "invoice-register";

function stubResponse(status: number, body: string, contentType = "text/html; charset=utf-8"): SubmitFetchResponse {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  };
}

test("browser-print: live GET per call with declared view + bounds; HTML preserved", async () => {
  const calls: Array<{ url: string; init: unknown }> = [];
  const first = await fetchPrintView({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return stubResponse(200, "<!DOCTYPE html><html><body><table></table></body></html>");
    },
    printBase: BASE,
    view: VIEW,
    limit: 50,
  });
  const second = await fetchPrintView({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return stubResponse(200, "<!DOCTYPE html><html><body><table></table></body></html>");
    },
    printBase: BASE,
    view: VIEW,
  });
  /* No caching: current grants per open, two calls, two GETs. */
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, `${BASE}/${VIEW}?limit=50`);
  assert.equal(calls[1]!.url, `${BASE}/${VIEW}`);
  assert.equal((calls[0]!.init as { method: string }).method, "GET");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.match(first.html, /<table><\/table>/);
  assert.equal(second.ok, true);
});

test("browser-print: view names fail closed; unsafe bases fall back", async () => {
  for (const view of ["", "../secret", "a/b", "UPPER", "dot.name", "has space"]) {
    await assert.rejects(
      fetchPrintView({
        fetchImpl: async () => stubResponse(200, "<html></html>"),
        printBase: BASE,
        view,
      }),
      /view/,
    );
  }
  await assert.rejects(
    fetchPrintView({
      fetchImpl: async () => stubResponse(200, "<html></html>"),
      printBase: "",
      view: VIEW,
    }),
    /printBase|base/,
  );
  const evil = renderPrintLink({ printBase: "javascript:alert(1)", view: VIEW });
  assert.ok(!evil.includes("javascript:"));
  assert.ok(evil.includes('href="#"'));
});

test("browser-print: non-HTML answers and error JSON digest explicitly", async () => {
  const json = await fetchPrintView({
    fetchImpl: async () => stubResponse(200, JSON.stringify({ code: "x", message: "y" }), "application/json"),
    printBase: BASE,
    view: VIEW,
  });
  assert.equal(json.ok, false);
  if (json.ok) return;
  assert.equal(json.error.code, "transport");
  const denied = await fetchPrintView({
    fetchImpl: async () => stubResponse(403, JSON.stringify({ code: "forbidden", message: "No." })),
    printBase: BASE,
    view: VIEW,
  });
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.error.code, "forbidden");
  const transport = await fetchPrintView({
    fetchImpl: async () => {
      throw new Error("down");
    },
    printBase: BASE,
    view: VIEW,
  });
  assert.equal(transport.ok, false);
  if (transport.ok) return;
  assert.equal(transport.error.code, "transport");
});

test("browser-print: link and frame render safe, sandboxed, never inlined", async () => {
  const link = renderPrintLink({ printBase: BASE, view: VIEW, label: "Print <register>" });
  const linkPage = await loadHtml(link);
  try {
    const anchor = linkPage.document.querySelector("a");
    assert.ok(anchor !== null);
    assert.equal(anchor?.getAttribute("href"), `${BASE}/${VIEW}`);
    assert.equal(anchor?.getAttribute("target"), "_blank");
    assert.equal(anchor?.getAttribute("rel"), "noopener");
    assert.ok(!link.includes("<register>"));
  } finally {
    await linkPage.close();
  }
  const frame = renderPrintFrame({ regionId: "print-frame", printBase: BASE, view: VIEW, title: "Invoices" });
  const framePage = await loadHtml(frame);
  try {
    const iframe = framePage.document.querySelector("iframe");
    assert.ok(iframe !== null);
    assert.equal(iframe?.getAttribute("src"), `${BASE}/${VIEW}`);
    assert.ok(iframe?.hasAttribute("sandbox"));
    assert.equal(iframe?.getAttribute("title"), "Invoices");
  } finally {
    await framePage.close();
  }
  assert.throws(() => renderPrintFrame({ regionId: "bad id", printBase: BASE, view: VIEW }), /region/);
  assert.throws(() => renderPrintLink({ printBase: BASE, view: "../x" }), /view/);
});
