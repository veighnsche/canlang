/**
 * B2 delivery journey (L7 directory; this ONE file is the B2 delivery
 * case body per the join contract in `tests/integration/README.md`).
 *
 * Drives the REAL L4 mail adapter (`EmailV1Adapter`) against the REAL
 * L4 scenario tables served by the REAL landed playback endpoint
 * (`createPlaybackHandler`, PR #93) over a `node:http` bridge, and
 * checks every completion against the `CapabilityCompletion` envelope
 * rule. Every evidence row is labelled `local` in its detail string;
 * no live providers are touched (all hosts are `*.playback` served
 * in-process).
 *
 * Producer loading follows the lane02 join precedent exactly: the L4
 * sources load through a NON-LITERAL dynamic specifier, so this file
 * typechecks with the producers absent and fails loud (every row
 * `unsupported` with the exact absent detail below) when the load
 * fails at runtime. Four rows are permanently `unsupported` and name
 * the exact unmet producer contracts for dispatch-orchestrated
 * retry, skipped delivery, changed versions and attachments.
 *
 * Only mail is driven here: it is the delivery-shaped provider
 * (delivery identity + reconcile). Models/judgments/media are
 * request/response capabilities, not deliveries; their playback
 * equivalence is already proven by the differential suite
 * (`packages/testkit/test/playback.test.ts`).
 */
import http from "node:http";
import type { Socket } from "node:net";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createReport, diffReportValues } from "@canlang/testkit";
import type {
  ObservationMismatch,
  ReportValue,
  ResolvedCaller,
  TableCaseResult,
  TableRowResult,
} from "@canlang/contracts";
import { createPlaybackHandler, type PlaybackHandler } from "@canlang/testkit/fixtures/playback";
import {
  B2_MAIL_JOURNEY,
  assertB2CompletionRedacted,
  b2DeliveryId,
  b2MailInput,
  playbackSeedHost,
  readB2Completion,
  type B2MailJourneyRow,
} from "@canlang/testkit/fixtures/b2-delivery";

/** Exact absent-producer detail every producer-dependent row carries. */
const ABSENT_SENTENCE =
  "L4 mail producer absent; run root `bun run test` from a checkout with packages/services/src/{scenarios,mail/adapter}.ts";
const ABSENT_DETAIL = `local | ${ABSENT_SENTENCE}`;

const LOCAL_CALLER: ResolvedCaller = {
  account: "local-b2-delivery",
  team: null,
  roles: [],
  authenticated: false,
};

/** Short client timeout so the three hang seeds resolve to unknown fast. */
const HANG_TIMEOUT_MS = 250;
/** Generous timeout for answering scripts (CI safety, no hangs scripted). */
const SEND_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Producer surface (dynamic TS-source import; absent producers route to
// unsupported). Structural mirrors only — @canlang/services has no build,
// so static imports (even type-only) would drag L4 sources into the root
// check; the non-literal specifier keeps tsc blind (lane02 precedent).
// ---------------------------------------------------------------------------

const SCENARIOS_SPECIFIER = "@canlang/services/scenarios";
const ADAPTER_SPECIFIER = "@canlang/services/mail/adapter";

interface ScenarioTableView {
  readonly provider: string;
  readonly scenario: string;
  readonly script: unknown;
}

interface MailAdapter {
  send(input: unknown, options: { readonly deliveryId: string }): Promise<unknown>;
  reconcile(deliveryId: string): Promise<unknown>;
}

interface MailAdapterCtor {
  new (config: {
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly maxBodyBytes: number;
    readonly maxTransportBytes: number;
  }): MailAdapter;
}

interface DeliveryProducer {
  tables: readonly ScenarioTableView[];
  adapter: MailAdapterCtor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asScenarioTable(value: unknown, index: number): ScenarioTableView {
  if (
    !isRecord(value) ||
    typeof value["provider"] !== "string" ||
    typeof value["scenario"] !== "string" ||
    !("script" in value)
  ) {
    throw new Error(`SCENARIO_TABLES[${index}] must be {provider, scenario, script}`);
  }
  return { provider: value["provider"], scenario: value["scenario"], script: value["script"] };
}

async function loadProducer(): Promise<DeliveryProducer | null> {
  let scenariosMod: unknown;
  let adapterMod: unknown;
  try {
    scenariosMod = await import(SCENARIOS_SPECIFIER);
    adapterMod = await import(ADAPTER_SPECIFIER);
  } catch {
    return null;
  }
  if (!isRecord(scenariosMod) || !Array.isArray(scenariosMod["SCENARIO_TABLES"])) {
    throw new Error("services scenarios module loaded but exports no SCENARIO_TABLES array");
  }
  if (!isRecord(adapterMod) || typeof adapterMod["EmailV1Adapter"] !== "function") {
    throw new Error("services mail adapter module loaded but exports no EmailV1Adapter class");
  }
  const tables = (scenariosMod["SCENARIO_TABLES"] as unknown[]).map(asScenarioTable);
  const have = new Set(tables.map((table) => `${table.provider}:${table.scenario}`));
  const missing = B2_MAIL_JOURNEY.map((row) => row.seed).filter((seed) => !have.has(seed));
  if (missing.length > 0) {
    throw new Error(`L4 catalog drift: scenario table(s) missing: ${missing.join(", ")}`);
  }
  return {
    tables: tables.filter((table) => table.provider === "mail"),
    adapter: adapterMod["EmailV1Adapter"] as MailAdapterCtor,
  };
}

// ---------------------------------------------------------------------------
// Playback bridge (adapted from the S8d differential suite
// `packages/testkit/test/playback.test.ts`, L7-owned): serves one
// playback seed over node:http so the real adapter runs unmodified.
// ---------------------------------------------------------------------------

interface Bridge {
  readonly url: string;
  readonly close: () => Promise<void>;
}

const SKIPPED_BRIDGE_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
]);

async function startBridge(host: string, handler: Pick<PlaybackHandler, "fetch">): Promise<Bridge> {
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
        }
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (value === undefined || SKIPPED_BRIDGE_HEADERS.has(name)) {
            continue;
          }
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const method = req.method ?? "GET";
        const init: RequestInit = { method, headers };
        if (body.length > 0 && method !== "GET" && method !== "HEAD") {
          init.body = new Uint8Array(body);
        }
        const response = await handler.fetch(new Request(`http://${host}${req.url ?? "/"}`, init));
        const outHeaders: Record<string, string> = {};
        const contentType = response.headers.get("content-type");
        if (contentType !== null) {
          outHeaders["content-type"] = contentType;
        }
        const location = response.headers.get("location");
        if (location !== null) {
          outHeaders["location"] = location;
        }
        res.writeHead(response.status, outHeaders);
        if (response.body === null) {
          res.end();
          return;
        }
        const reader = response.body.getReader();
        const onClose = (): void => {
          void reader.cancel().catch(() => {});
        };
        res.on("close", onClose);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            if (!res.write(value)) {
              await once(res, "drain");
            }
          }
          res.end();
        } catch {
          res.destroy();
        } finally {
          res.off("close", onClose);
        }
      } catch {
        if (!res.headersSent) {
          try {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "bridge failure" }));
          } catch {
            // Connection already gone.
          }
        } else {
          res.destroy();
        }
      }
    })();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("bridge failed to bind an ephemeral port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async (): Promise<void> => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Row helpers (same shape as the lane02 join).
// ---------------------------------------------------------------------------

function passedRow(rowIndex: number, label: string, mismatches: ObservationMismatch[]): TableRowResult {
  if (mismatches.length > 0) {
    return {
      rowIndex,
      caller: LOCAL_CALLER,
      outcome: "failed",
      mismatches,
      detail: `local | ${label}: ${mismatches.length} mismatch(es)`,
    };
  }
  return { rowIndex, caller: LOCAL_CALLER, outcome: "passed", detail: `local | ${label}` };
}

function failedRow(rowIndex: number, label: string, problem: string): TableRowResult {
  return { rowIndex, caller: LOCAL_CALLER, outcome: "failed", detail: `local | ${label}: ${problem}` };
}

function unsupportedRow(rowIndex: number, detail: string): TableRowResult {
  return { rowIndex, caller: LOCAL_CALLER, outcome: "unsupported", detail };
}

function checkJourneyRow(
  row: B2MailJourneyRow,
  send: { status: string; errorCode: string | null },
  followup: { status: string; errorCode: string | null } | null,
  logPaths: readonly string[],
): ObservationMismatch[] {
  const mismatches: ObservationMismatch[] = [
    ...diffReportValues(`${row.seed}.send.status`, row.sendStatus, send.status as ReportValue),
    ...diffReportValues(
      `${row.seed}.send.error`,
      row.sendErrorCode as ReportValue,
      send.errorCode as ReportValue,
    ),
  ];
  if (row.followupStatus === null || followup === null) {
    if (row.followupStatus !== null || followup !== null) {
      mismatches.push({
        observation: `${row.seed}.followup.presence`,
        expected: (row.followupStatus ?? "absent") as ReportValue,
        actual: (followup === null ? "absent" : followup.status) as ReportValue,
      });
    }
  } else {
    mismatches.push(
      ...diffReportValues(`${row.seed}.followup.status`, row.followupStatus, followup.status as ReportValue),
      ...diffReportValues(
        `${row.seed}.followup.error`,
        row.followupErrorCode as ReportValue,
        followup.errorCode as ReportValue,
      ),
    );
  }
  // The playback mail log records POST /send requests only; reconcile
  // GETs are served but not logged (same as the harness request log).
  const expectedLog =
    row.flow === "send-retry"
      ? ["POST /send", "POST /send"]
      : row.seed === "mail:send-redirect-loop"
        ? null
        : ["POST /send"];
  if (expectedLog === null) {
    if (logPaths.length < 2) {
      mismatches.push({
        observation: `${row.seed}.attempts`,
        expected: ">= 2 requests (redirect loop)" as ReportValue,
        actual: logPaths.join(", ") as ReportValue,
      });
    }
  } else {
    mismatches.push(
      ...diffReportValues(
        `${row.seed}.attempts`,
        expectedLog as unknown as ReportValue,
        logPaths as unknown as ReportValue,
      ),
    );
  }
  return mismatches;
}

function blockedRows(): TableRowResult[] {
  return [
    unsupportedRow(
      0,
      "local | BLOCKED (P-B2c dispatch executor): skipped delivery (superseded/ineligible) — only the dispatcher emits skipped; adapters never do",
    ),
    unsupportedRow(
      1,
      "local | BLOCKED (P-B2c occurrence executors + L1 emission): dispatch-orchestrated retry (outbox schedule/backoff/receipt); the send-retry row above observes only the adapter-attempt transport primitive",
    ),
    unsupportedRow(
      2,
      "local | BLOCKED (P-B2c + L3 versions/admission + L1 emission): changed versions (queued delivery superseded by a record-version change)",
    ),
    unsupportedRow(
      3,
      "local | BLOCKED (P-B2d file journey + F2 page decision): attachment-bearing notice (finalized file refs need finalize→provenance→attach)",
    ),
  ];
}

// ---------------------------------------------------------------------------
// The join case.
// ---------------------------------------------------------------------------

describe("b2 delivery journey", () => {
  it("observes failed/unknown delivery + retry + reconcile over playback", async () => {
    const producer = await loadProducer();
    const builder = createReport({ digest: "b2-delivery-mail", sourceRevision: "b2-delivery-mail" });

    if (producer === null) {
      // Strict: producers live in-repo, so absence is a broken checkout,
      // not a skippable state. The gate must never green on unsupported rows.
      throw new Error("b2-delivery-mail: producer modules failed to load (partial checkout?)");
    }

    const handler = createPlaybackHandler(producer.tables);
    const journeyRows: TableRowResult[] = [];
    for (const [rowIndex, row] of B2_MAIL_JOURNEY.entries()) {
      const label = `journey:${row.seed}`;
      const bridge = await startBridge(playbackSeedHost(row.seed), handler).catch(
        (err: unknown): null => {
          journeyRows.push(
            failedRow(rowIndex, label, `bridge failed: ${err instanceof Error ? err.message : String(err)}`),
          );
          return null;
        },
      );
      if (bridge === null) {
        continue;
      }
      try {
        const adapter = new producer.adapter({
          baseUrl: bridge.url,
          timeoutMs: row.flow === "send-reconcile" ? HANG_TIMEOUT_MS : SEND_TIMEOUT_MS,
          maxBodyBytes: 1_000_000,
          maxTransportBytes: 10_000_000,
        });
        const deliveryId = b2DeliveryId(rowIndex);
        const input = b2MailInput(rowIndex);
        const sendRaw = await adapter.send({ ...input }, { deliveryId });
        const send = readB2Completion(sendRaw, `${label}.send`);
        assertB2CompletionRedacted(sendRaw, input, `${label}.send`);
        if ((sendRaw as { delivery_id?: unknown }).delivery_id !== deliveryId) {
          journeyRows.push(failedRow(rowIndex, label, "send completion echoes the wrong delivery_id"));
          continue;
        }
        let followup: { status: string; errorCode: string | null } | null = null;
        if (row.flow === "send-retry") {
          const retryRaw = await adapter.send({ ...input }, { deliveryId });
          followup = readB2Completion(retryRaw, `${label}.retry`);
          assertB2CompletionRedacted(retryRaw, input, `${label}.retry`);
        } else if (row.flow === "send-reconcile") {
          const foundRaw = await adapter.reconcile(deliveryId);
          followup = readB2Completion(foundRaw, `${label}.reconcile`);
          assertB2CompletionRedacted(foundRaw, input, `${label}.reconcile`);
        }
        const logPaths = handler.log(row.seed).map((entry) => `${entry.method} ${entry.path}`);
        journeyRows.push(passedRow(rowIndex, label, checkJourneyRow(row, send, followup, logPaths)));
      } catch (err) {
        journeyRows.push(
          failedRow(rowIndex, label, err instanceof Error ? err.message : String(err)),
        );
      } finally {
        await bridge.close();
      }
    }
    builder.addCase({ kind: "table", operation: "b2.delivery.mail", rows: journeyRows });
    builder.addCase({ kind: "table", operation: "b2.delivery.blocked", rows: blockedRows() });

    const report = builder.build();
    expect(report.summary.passed).toBe(B2_MAIL_JOURNEY.length);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.setupFailed).toBe(0);
    expect(report.summary.unsupported).toBe(4);
    for (const table of report.cases) {
      if (table.kind !== "table") {
        continue;
      }
      for (const row of table.rows) {
        expect(row.detail).toContain("local");
      }
    }
  }, 90000);
});
