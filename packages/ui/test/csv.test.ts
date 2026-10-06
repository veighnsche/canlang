import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PresentationContext } from "@canlang/contracts";
import { CSRF_FIELD } from "@canlang/contracts";
import type { SubmitFetchResponse } from "../src/client.js";
import { message } from "../src/messages.js";
import {
  CSV_UI_MAX_ROWS,
  csvReviewForm,
  digestBusinessError,
  parseCsvText,
} from "../src/csv/parse.js";
import {
  csvPreviewSection,
  parseReviewPayload,
  submitCsvReview,
  type CsvReviewModel,
} from "../src/csv/preview.js";
import {
  collectCommitSelections,
  csvConfirmSection,
  mintOperationId,
  parseCommitPayload,
  submitCsvCommit,
  type CsvCommitOutcomeModel,
} from "../src/csv/confirm.js";
import { loadHtml } from "./harness.js";

/**
 * Pins server UUID_V7_PATTERN (interfaces/src/envelope/validate.ts)
 * and RFC 9562 §5.11. The UI minter must satisfy the server rule.
 */
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeContext(overrides: Partial<PresentationContext> = {}): PresentationContext {
  return {
    preferredLocales: [],
    appDefaultLocale: "en",
    theme: { mode: "system", accent: "blue", density: "comfortable" },
    path: "/",
    isPartial: false,
    csrfToken: "csrf-123",
    principal: null,
    invocation: { request: "req-1" },
    query: async () => ({ rows: [], columns: [] }),
    ...overrides,
  };
}

function stubResponse(status: number, body: string): SubmitFetchResponse {
  return {
    status,
    headers: { get: () => null },
    text: async () => body,
  };
}

function reviewFixture(): CsvReviewModel {
  return {
    operation: "create-task",
    review_id: "rev-0123456789abcdef",
    consent: {
      review_id: "rev-0123456789abcdef",
      operation: "create-task",
      principal: "user-1",
      candidates_digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      candidate_count: 1,
    },
    rows: [
      { index: 0, status: "valid", inputs: { title: "write docs" } },
      {
        index: 1,
        status: "invalid",
        inputs: { title: "" },
        error: {
          code: "validation",
          message: "missing required field",
          fields: [{ path: "/title", code: "required", message: "missing required field" }],
        },
      },
      { index: 2, status: "duplicate", inputs: { title: "write docs" }, duplicate_of: 0 },
    ],
    counts: { total: 3, valid: 1, invalid: 1, duplicate: 1 },
  };
}

function outcomeFixture(): CsvCommitOutcomeModel {
  return {
    operation: "create-task",
    review_id: "rev-0123456789abcdef",
    principal: { user_id: "user-1", team_id: null, admitted_at: "2026-10-06T00:00:00.000Z" },
    rows: [
      { index: 0, operation_id: "0193a1b2-c3d4-7e5f-8123-456789abcdef", status: "committed", result: { id: "task-9" } },
      {
        index: 1,
        operation_id: "0193a1b2-c3d4-7e5f-8123-456789abcdf0",
        status: "failed",
        error: { code: "busy", message: "try again", retryable: true },
      },
      {
        index: 2,
        operation_id: "0193a1b2-c3d4-7e5f-8123-456789abcdf1",
        status: "invalid",
        error: { code: "validation", message: "missing required field" },
      },
      {
        index: 3,
        operation_id: "0193a1b2-c3d4-7e5f-8123-456789abcdf2",
        status: "duplicate",
        duplicate_of: 0,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// parse.ts: advisory CSV parse.
// ---------------------------------------------------------------------------

describe("csv advisory parse", () => {
  it("parses header plus rows", () => {
    const parsed = parseCsvText("a,b\n1,2\n3,4\n");
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.header, ["a", "b"]);
    assert.equal(parsed.rows.length, 2);
    assert.deepEqual(parsed.rows[0], { cells: ["1", "2"], malformed: false });
  });

  it("handles CRLF, quotes spanning lines, and escaped quotes", () => {
    const parsed = parseCsvText('a,b\r\n"x\ny","c""d"\r\n');
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.rows[0], { cells: ["x\ny", 'c"d'], malformed: false });
  });

  it("preserves blank lines as malformed rows and flags field-count mismatches", () => {
    // Mirrors the server implementation exactly: a blank line yields a
    // single-empty-field record (malformed against multi-column headers),
    // not a skip. The server doc comment says "skipped"; the server code
    // preserves — the advisory parse follows the code (verified at
    // interfaces/src/http/csv.ts recordHadChars handling).
    const parsed = parseCsvText("a,b\n\n1,2,3\n4,5\n");
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.rows.length, 3);
    assert.deepEqual(parsed.rows[0], { cells: [""], malformed: true });
    assert.deepEqual(parsed.rows[1], { cells: ["1", "2", "3"], malformed: true });
    assert.deepEqual(parsed.rows[2], { cells: ["4", "5"], malformed: false });
  });

  it("treats a lone CR as a literal character", () => {
    const parsed = parseCsvText("a\rb\n1\n");
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.header, ["a\rb"]);
  });

  it("returns parse failures as data", () => {
    assert.deepEqual(parseCsvText('"abc'), {
      ok: false,
      error: { kind: "parse", message: "Unterminated quoted field in CSV text." },
    });
    assert.deepEqual(parseCsvText(""), {
      ok: false,
      error: { kind: "parse", message: "CSV text has no header row." },
    });
  });

  it("enforces the 1000-row ceiling", () => {
    assert.equal(CSV_UI_MAX_ROWS, 1000);
    const big = `h\n${"x\n".repeat(1001)}`;
    const over = parseCsvText(big);
    assert.equal(over.ok, false);
    if (over.ok) return;
    assert.equal(over.error.kind, "limit");
    const exact = parseCsvText(`h\n${"x\n".repeat(1000)}`);
    assert.equal(exact.ok, true);
  });

  it("throws on non-string input (programmer misuse)", () => {
    assert.throws(() => parseCsvText(42 as unknown as string), /needs CSV text/);
  });
});

describe("csv error digests", () => {
  it("digests full and minimal server errors", () => {
    assert.deepEqual(
      digestBusinessError({
        code: "validation",
        message: "bad row",
        fields: [{ path: "/title", code: "required", message: "missing" }],
        retryable: false,
      }),
      {
        code: "validation",
        message: "bad row",
        fields: [{ path: "/title", code: "required", message: "missing" }],
        retryable: false,
      },
    );
    assert.deepEqual(digestBusinessError({ code: "conflict", message: "stale" }), {
      code: "conflict",
      message: "stale",
    });
  });

  it("skips malformed field entries and rejects non-error shapes", () => {
    assert.deepEqual(
      digestBusinessError({ code: "validation", message: "m", fields: [{ path: "/a", message: "x" }, 42, null] }),
      { code: "validation", message: "m", fields: [{ path: "/a", message: "x" }] },
    );
    assert.equal(digestBusinessError(null), null);
    assert.equal(digestBusinessError({ code: "", message: "m" }), null);
    assert.equal(digestBusinessError({ code: "c" }), null);
    assert.equal(digestBusinessError("boom"), null);
  });
});

describe("csv review form", () => {
  it("renders operations, textarea, csrf, and region wiring", async () => {
    const html = await csvReviewForm({
      context: makeContext(),
      reviewPath: "/api/csv/review",
      regionId: "csv-preview",
      operations: [{ name: "create-task", caption: message("Create task", {}) }],
    });
    const page = await loadHtml(html);
    try {
      const form = page.document.querySelector('form[data-csv-review-form="csv-preview"]');
      assert.ok(form !== null);
      assert.equal(form?.getAttribute("action"), "/api/csv/review");
      const csrf = form?.querySelector(`input[type="hidden"][name="${CSRF_FIELD}"]`);
      assert.equal(csrf?.getAttribute("value"), "csrf-123");
      const options = form?.querySelectorAll('select[name="operation"] option') ?? [];
      assert.equal(options.length, 1);
      assert.equal(options[0]?.getAttribute("value"), "create-task");
      assert.ok(form?.querySelector('textarea[name="csv"]') !== null);
    } finally {
      await page.close();
    }
  });

  it("throws on empty path, no operations, and bad region", async () => {
    const base = {
      context: makeContext(),
      reviewPath: "/api/csv/review",
      regionId: "csv-preview",
      operations: [{ name: "op", caption: message("Op", {}) }],
    };
    await assert.rejects(csvReviewForm({ ...base, reviewPath: "" }), /reviewPath/);
    await assert.rejects(csvReviewForm({ ...base, operations: [] }), /at least one operation/);
    await assert.rejects(csvReviewForm({ ...base, regionId: "" }), /region/);
  });
});

// ---------------------------------------------------------------------------
// preview.ts: review payload guard.
// ---------------------------------------------------------------------------

describe("csv review payload guard", () => {
  it("accepts the server review shape", () => {
    const model = parseReviewPayload(JSON.parse(JSON.stringify(reviewFixture())));
    assert.equal(model.review_id, "rev-0123456789abcdef");
    assert.equal(model.rows.length, 3);
    assert.deepEqual(model.counts, { total: 3, valid: 1, invalid: 1, duplicate: 1 });
  });

  it("throws on malformed bodies", () => {
    assert.throws(() => parseReviewPayload(null), /body/);
    assert.throws(() => parseReviewPayload({ ...reviewFixture(), operation: "" }), /operation/);
    assert.throws(() => parseReviewPayload({ ...reviewFixture(), consent: {} }), /consent/);
    assert.throws(() => parseReviewPayload({ ...reviewFixture(), rows: [{ index: 0 }] }), /status/);
    assert.throws(
      () => parseReviewPayload({ ...reviewFixture(), rows: [{ index: -1, status: "valid", inputs: {} }] }),
      /index/,
    );
    assert.throws(() => parseReviewPayload({ ...reviewFixture(), counts: {} }), /counts/);
  });
});

// ---------------------------------------------------------------------------
// preview.ts: preview section render.
// ---------------------------------------------------------------------------

describe("csv preview section", () => {
  it("echoes counts, consent, and every preserved row", async () => {
    const html = await csvPreviewSection({
      context: makeContext(),
      review: reviewFixture(),
      commitPath: "/api/csv/commit",
      csvText: "title\nwrite docs\n",
      regionId: "csv-preview",
    });
    const page = await loadHtml(html);
    try {
      const section = page.document.querySelector('section[data-region="csv-preview"]');
      assert.ok(section !== null);
      assert.match(section?.textContent ?? "", /rev-0123456789abcdef/);
      assert.match(section?.textContent ?? "", /0123456789abcdef/);
      // Valid row: checkbox + replay key.
      const checkbox = section?.querySelector('input[type="checkbox"][name="rows[0].selected"]');
      assert.ok(checkbox !== null);
      const replayKey = section?.querySelector('input[type="hidden"][name="rows[0].operation_id"]');
      const key = replayKey?.getAttribute("value") ?? "";
      assert.match(key, UUID_V7_PATTERN);
      // Invalid row: kept error, no checkbox.
      assert.equal(section?.querySelector('input[name="rows[1].selected"]'), null);
      assert.match(section?.textContent ?? "", /missing required field/);
      // Duplicate row: pointer to the first occurrence.
      const pointer = section?.querySelector('a[href="#csv-row-0"]');
      assert.ok(pointer !== null);
      // Commit hiddens: csrf, operation, csv echo, consent members.
      const form = section?.querySelector('form[data-csv-commit-form="csv-preview"]');
      assert.equal(form?.getAttribute("action"), "/api/csv/commit");
      assert.equal(form?.querySelector('input[name="consent.candidate_count"]')?.getAttribute("value"), "1");
      assert.equal(form?.querySelector('input[name="csv"]')?.getAttribute("value"), "title\nwrite docs\n");
    } finally {
      await page.close();
    }
  });

  it("armors formula cells and escapes hostile markup", async () => {
    const review: CsvReviewModel = {
      ...reviewFixture(),
      rows: [{ index: 0, status: "valid", inputs: { title: "=1+1", note: "<img src=x onerror=1>" } }],
      counts: { total: 1, valid: 1, invalid: 0, duplicate: 0 },
    };
    const html = await csvPreviewSection({
      context: makeContext(),
      review,
      commitPath: "/api/csv/commit",
      csvText: "title,note\n",
      regionId: "csv-preview",
    });
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("&lt;img"));
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("img"), null);
    } finally {
      await page.close();
    }
  });

  it("renders the no-valid-rows state and the renewal hook", async () => {
    const review: CsvReviewModel = {
      ...reviewFixture(),
      rows: reviewFixture().rows.slice(1),
      counts: { total: 2, valid: 0, invalid: 1, duplicate: 1 },
    };
    const html = await csvPreviewSection({
      context: makeContext(),
      review,
      commitPath: "/api/csv/commit",
      csvText: "title\n\n",
      regionId: "csv-preview",
      renewal: { notice: message("Candidates changed; review again.", {}), href: "#csv-review" },
    });
    const page = await loadHtml(html);
    try {
      assert.match(page.document.body.textContent ?? "", /No valid rows to commit/);
      const renewal = page.document.querySelector('p[role="alert"] a[href="#csv-review"]');
      assert.ok(renewal !== null);
      assert.equal(page.document.querySelector("form[data-csv-commit-form]"), null);
    } finally {
      await page.close();
    }
  });

  it("throws on empty commit path, missing csv echo, and bad region", async () => {
    const base = {
      context: makeContext(),
      review: reviewFixture(),
      commitPath: "/api/csv/commit",
      csvText: "title\n",
      regionId: "csv-preview",
    };
    await assert.rejects(csvPreviewSection({ ...base, commitPath: "" }), /commitPath/);
    await assert.rejects(csvPreviewSection({ ...base, csvText: "" }), /echoed CSV/);
    await assert.rejects(csvPreviewSection({ ...base, regionId: "" }), /region/);
  });
});

// ---------------------------------------------------------------------------
// preview.ts: review transport.
// ---------------------------------------------------------------------------

describe("csv review transport", () => {
  it("posts JSON with the CSRF header and guards the review", async () => {
    const seen: Array<{ url: string; init: { method: string; headers: Record<string, string>; body?: string | Uint8Array } }> = [];
    const result = await submitCsvReview({
      fetchImpl: (async (url: string, init) => {
        seen.push({ url, init });
        return stubResponse(200, JSON.stringify(reviewFixture()));
      }),
      action: "/api/csv/review",
      csrf: "csrf-123",
      operation: "create-task",
      csv: "title\nwrite docs\n",
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, "/api/csv/review");
    assert.equal(seen[0]?.init.method, "POST");
    assert.equal(seen[0]?.init.headers["content-type"], "application/json");
    assert.equal(seen[0]?.init.headers["x-csrf-token"], "csrf-123");
    assert.deepEqual(JSON.parse(String(seen[0]?.init.body)), { operation: "create-task", csv: "title\nwrite docs\n" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.review.review_id, "rev-0123456789abcdef");
  });

  it("digests server error bodies and transport failures", async () => {
    const errored = await submitCsvReview({
      fetchImpl: (async () => stubResponse(400, JSON.stringify({ code: "validation", message: "Missing CSV text." }))),
      action: "/api/csv/review",
      csrf: "csrf-123",
      operation: "create-task",
      csv: "title\n",
    });
    assert.deepEqual(errored, { ok: false, error: { code: "validation", message: "Missing CSV text." } });
    const thrown = await submitCsvReview({
      fetchImpl: (async () => {
        throw new Error("down");
      }),
      action: "/api/csv/review",
      csrf: "csrf-123",
      operation: "create-task",
      csv: "title\n",
    });
    assert.equal(thrown.ok, false);
    if (thrown.ok) return;
    assert.equal(thrown.error.code, "transport");
    const nonJson = await submitCsvReview({
      fetchImpl: (async () => stubResponse(500, "<html>nope</html>")),
      action: "/api/csv/review",
      csrf: "csrf-123",
      operation: "create-task",
      csv: "title\n",
    });
    assert.equal(nonJson.ok, false);
    if (nonJson.ok) return;
    assert.equal(nonJson.error.code, "transport");
  });

  it("throws on empty action, csrf, operation, and csv", async () => {
    const base = {
      fetchImpl: (async () => stubResponse(200, "{}")),
      action: "/api/csv/review",
      csrf: "csrf-123",
      operation: "create-task",
      csv: "title\n",
    };
    await assert.rejects(submitCsvReview({ ...base, action: "" }), /action/);
    await assert.rejects(submitCsvReview({ ...base, csrf: "" }), /CSRF/);
    await assert.rejects(submitCsvReview({ ...base, operation: "" }), /operation/);
    await assert.rejects(submitCsvReview({ ...base, csv: "" }), /CSV text/);
  });
});

// ---------------------------------------------------------------------------
// confirm.ts: operation_id minter.
// ---------------------------------------------------------------------------

describe("csv operation_id minter", () => {
  it("mints UUIDv7 ids with the clock in the time bits", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const id = mintOperationId(
        () => 1791290000000 + i,
        (target) => target.fill(i % 251),
      );
      assert.match(id, UUID_V7_PATTERN);
      const ms = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
      assert.equal(ms, 1791290000000 + i);
      seen.add(id);
    }
    assert.equal(seen.size, 100);
  });

  it("mints valid ids on host defaults and rejects bad clocks", () => {
    assert.match(mintOperationId(), UUID_V7_PATTERN);
    assert.throws(() => mintOperationId(() => -1, (target) => target.fill(1)), /clock/);
    assert.throws(() => mintOperationId(() => Number.NaN, (target) => target.fill(1)), /clock/);
  });
});

// ---------------------------------------------------------------------------
// confirm.ts: selection collection.
// ---------------------------------------------------------------------------

describe("csv selection collection", () => {
  it("collects checked rows with replay keys in index order", () => {
    const collected = collectCommitSelections({
      "rows[2].selected": "on",
      "rows[2].operation_id": "id-2",
      "rows[0].selected": "on",
      "rows[0].operation_id": "id-0",
      "rows[1].operation_id": "id-1",
      operation: "create-task",
    });
    assert.deepEqual(collected, {
      ok: true,
      selections: [
        { index: 0, operation_id: "id-0" },
        { index: 2, operation_id: "id-2" },
      ],
    });
  });

  it("returns validation data for empty, keyless, and duplicate selections", () => {
    assert.deepEqual(collectCommitSelections({ operation: "op" }), {
      ok: false,
      error: { code: "validation", message: "Commit selects no rows." },
    });
    assert.deepEqual(collectCommitSelections({ "rows[1].selected": "on" }), {
      ok: false,
      error: { code: "validation", message: "Row 1 is missing its replay key." },
    });
    assert.deepEqual(
      collectCommitSelections({
        "rows[0].selected": "on",
        "rows[0].operation_id": "same",
        "rows[1].selected": "on",
        "rows[1].operation_id": "same",
      }),
      { ok: false, error: { code: "validation", message: "Duplicate operation_id in commit batch." } },
    );
  });

  it("throws on host misuse (non-map, unsafe indexes)", () => {
    assert.throws(() => collectCommitSelections(null as unknown as Record<string, string>), /flat map/);
    assert.throws(
      () => collectCommitSelections({ "rows[99999999999999999999].selected": "on" }),
      /safe integer/,
    );
  });
});

// ---------------------------------------------------------------------------
// confirm.ts: outcome payload guard.
// ---------------------------------------------------------------------------

describe("csv outcome payload guard", () => {
  it("accepts the server outcome shape", () => {
    const model = parseCommitPayload(JSON.parse(JSON.stringify(outcomeFixture())));
    assert.equal(model.principal.user_id, "user-1");
    assert.equal(model.rows.length, 4);
  });

  it("throws on malformed bodies", () => {
    assert.throws(() => parseCommitPayload(null), /body/);
    assert.throws(() => parseCommitPayload({ ...outcomeFixture(), principal: { user_id: "" } }), /user_id/);
    assert.throws(() => parseCommitPayload({ ...outcomeFixture(), rows: [{ index: 0 }] }), /operation_id/);
    assert.throws(
      () => parseCommitPayload({ ...outcomeFixture(), rows: [{ index: 0, operation_id: "k", status: "nope" }] }),
      /status/,
    );
  });
});

// ---------------------------------------------------------------------------
// confirm.ts: confirm section render.
// ---------------------------------------------------------------------------

describe("csv confirm section", () => {
  it("renders principal, counts, and every per-row outcome", async () => {
    const html = await csvConfirmSection({
      context: makeContext(),
      outcome: outcomeFixture(),
      regionId: "csv-confirm",
    });
    const page = await loadHtml(html);
    try {
      const section = page.document.querySelector('section[data-region="csv-confirm"]');
      assert.ok(section !== null);
      assert.match(section?.textContent ?? "", /user-1/);
      assert.match(section?.textContent ?? "", /rev-0123456789abcdef/);
      assert.match(section?.textContent ?? "", /task-9/);
      assert.match(section?.textContent ?? "", /try again/);
      assert.match(section?.textContent ?? "", /missing required field/);
      assert.match(section?.textContent ?? "", /duplicate of row 0/);
      // Replay keys show shortened with the full key in title.
      const key = section?.querySelector("code[title^='0193a1b2']");
      assert.ok(key !== null);
      assert.equal(key?.textContent, "0193a1b2");
    } finally {
      await page.close();
    }
  });

  it("truncates long results and renders the renewal hook", async () => {
    const outcome: CsvCommitOutcomeModel = {
      ...outcomeFixture(),
      rows: [{ index: 0, operation_id: "k", status: "committed", result: { blob: "x".repeat(1000) } }],
    };
    const html = await csvConfirmSection({
      context: makeContext(),
      outcome,
      regionId: "csv-confirm",
      renewal: { notice: message("Candidates changed; review again.", {}), href: "#csv-review" },
    });
    assert.ok(html.includes("…"));
    assert.ok(!html.includes("x".repeat(1000)));
    const page = await loadHtml(html);
    try {
      assert.ok(page.document.querySelector('p[role="alert"] a[href="#csv-review"]') !== null);
    } finally {
      await page.close();
    }
  });

  it("throws on a bad region", async () => {
    await assert.rejects(
      csvConfirmSection({ context: makeContext(), outcome: outcomeFixture(), regionId: "" }),
      /region/,
    );
  });
});

// ---------------------------------------------------------------------------
// confirm.ts: commit transport.
// ---------------------------------------------------------------------------

describe("csv commit transport", () => {
  it("posts the commit envelope and guards the outcome", async () => {
    const seen: Array<{ url: string; init: { method: string; headers: Record<string, string>; body?: string | Uint8Array } }> = [];
    const consent = reviewFixture().consent;
    const result = await submitCsvCommit({
      fetchImpl: (async (url: string, init) => {
        seen.push({ url, init });
        return stubResponse(200, JSON.stringify(outcomeFixture()));
      }),
      action: "/api/csv/commit",
      csrf: "csrf-123",
      operation: "create-task",
      csv: "title\nwrite docs\n",
      consent,
      selections: [{ index: 0, operation_id: "0193a1b2-c3d4-7e5f-8123-456789abcdef" }],
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.init.headers["x-csrf-token"], "csrf-123");
    assert.deepEqual(JSON.parse(String(seen[0]?.init.body)), {
      operation: "create-task",
      csv: "title\nwrite docs\n",
      consent,
      rows: [{ index: 0, operation_id: "0193a1b2-c3d4-7e5f-8123-456789abcdef" }],
    });
    assert.equal(result.ok, true);
  });

  it("passes conflict through as renewable-error data", async () => {
    const result = await submitCsvCommit({
      fetchImpl: (async () =>
        stubResponse(409, JSON.stringify({ code: "conflict", message: "Candidates changed since review; renewed consent required." }))),
      action: "/api/csv/commit",
      csrf: "csrf-123",
      operation: "create-task",
      csv: "title\n",
      consent: reviewFixture().consent,
      selections: [{ index: 0, operation_id: "k" }],
    });
    assert.deepEqual(result, {
      ok: false,
      error: { code: "conflict", message: "Candidates changed since review; renewed consent required." },
    });
  });

  it("throws on empty action, csrf, operation, csv, and selections", async () => {
    const base = {
      fetchImpl: (async () => stubResponse(200, "{}")),
      action: "/api/csv/commit",
      csrf: "csrf-123",
      operation: "create-task",
      csv: "title\n",
      consent: reviewFixture().consent,
      selections: [{ index: 0, operation_id: "k" }],
    };
    await assert.rejects(submitCsvCommit({ ...base, action: "" }), /action/);
    await assert.rejects(submitCsvCommit({ ...base, csrf: "" }), /CSRF/);
    await assert.rejects(submitCsvCommit({ ...base, operation: "" }), /operation/);
    await assert.rejects(submitCsvCommit({ ...base, csv: "" }), /CSV text/);
    await assert.rejects(submitCsvCommit({ ...base, selections: [] }), /selection/);
  });
});
