/**
 * S8d-playback conformance: the workerd playback endpoint serves every
 * L4 scenario table identically to its `node:http` harness server.
 *
 * For each of the 41 tables this suite starts the REAL harness server
 * AND serves `createPlaybackHandler([table])` over a small `node:http`
 * bridge, runs the REAL adapter operation(s) against BOTH base URLs
 * (mirroring `packages/services/test/scenarios.test.ts`, including
 * hang/reconcile, redirect and paced-stream flows), and asserts
 * adapter-visible equivalence of the outcomes.
 */
import http from "node:http";
import type { Socket } from "node:net";
import { once } from "node:events";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { build as bundleWorker } from "esbuild";
import { EmailV1Adapter } from "@canlang/services/mail/adapter";
import {
  fixedAttachmentSizes,
  fixedClock,
  startControlledMailServer,
} from "@canlang/services/ports";
import { OllamaChatAdapter } from "@canlang/services/models/ollama";
import { startControlledOllamaServer } from "@canlang/services/models/harness";
import { SystemOneAdapter } from "@canlang/services/judgments/systemone";
import { startControlledSystemOneServer } from "@canlang/services/judgments/harness";
import { ComfyUINativeAdapter } from "@canlang/services/media/comfyui";
import { digestGraph } from "@canlang/services/media/mapping";
import { startControlledComfyServer } from "@canlang/services/media/harness";
import {
  SCENARIO_TABLES,
  ScenarioTableError,
  checkJudgmentsScript,
  checkMailScript,
  checkModelsScript,
  decodeMediaScript,
  findScenarioTable,
  parseScenarioTable,
} from "@canlang/services/scenarios";
import type { ScenarioTable } from "@canlang/services/scenarios";
import type {
  ApiGraph,
  EmailSendInput,
  ImageGenerateInput,
  JudgmentBatchInput,
  ModelChatInput,
  WorkflowNodeMapping,
} from "@canlang/contracts";
import {
  PlaybackScriptError,
  createPlaybackHandler,
  type PlaybackHandler,
} from "../src/fixtures/playback.js";

const CLOCK_NOW = 1_758_000_000_000;
const MODELS_MODEL = "llama-test";
const JUDGMENTS_MODEL = "jev-latest";

// Adapter factories mirror scenarios.test.ts exactly (same configs,
// same fixed clock) so both sides of each differential run agree.

function mustTable(provider: string, scenario: string): ScenarioTable {
  const table = findScenarioTable(provider, scenario);
  if (table === null) {
    throw new Error(`missing scenario table ${provider}:${scenario}`);
  }
  return table;
}

function mailInput(): EmailSendInput {
  return {
    to: "reviewer@example.test",
    subject: "Review",
    body: "Plan",
    attachments: [],
  };
}

function mailAdapter(baseUrl: string, timeoutMs = 5000): EmailV1Adapter {
  return new EmailV1Adapter({
    baseUrl,
    timeoutMs,
    maxBodyBytes: 1_000_000,
    maxTransportBytes: 10_000_000,
    clock: fixedClock(CLOCK_NOW),
    sizes: fixedAttachmentSizes({ file_a: 1000, file_b: 2000 }),
  });
}

function modelsInput(): ModelChatInput {
  return {
    model: MODELS_MODEL,
    messages: [{ role: "user", content: "Hello" }],
    maxTokens: 64,
  };
}

function modelsAdapter(baseUrl: string, timeoutMs = 5000): OllamaChatAdapter {
  return new OllamaChatAdapter({
    baseUrl,
    timeoutMs,
    maxBodyBytes: 1_000_000,
    models: [MODELS_MODEL],
    maxOutputTokens: 4096,
    clock: fixedClock(CLOCK_NOW),
  });
}

function judgmentsInput(): JudgmentBatchInput {
  return {
    model: JUDGMENTS_MODEL,
    state: { message: "Where is my invoice?" },
    questions: [
      {
        kind: "noul",
        id: "human",
        instructions: "Does this message require a staff reply?",
      },
      {
        kind: "choice",
        id: "route",
        instructions: "Which queue owns the request?",
        options: {
          billing: "Invoices and payments",
          technical: "Product support",
          other: "Neither queue",
        },
      },
      {
        kind: "score",
        id: "severity",
        instructions: "How quickly does this need attention?",
        levels: [
          "Routine follow-up",
          "Same-day attention",
          "Immediate disruption",
        ],
      },
    ],
  };
}

function judgmentsAdapter(baseUrl: string, timeoutMs = 5000): SystemOneAdapter {
  return new SystemOneAdapter({
    baseUrl,
    timeoutMs,
    maxBodyBytes: 1_000_000,
    models: [JUDGMENTS_MODEL],
    minChoiceOptions: 1,
    maxChoiceOptions: 255,
    minScoreLevels: 2,
    maxScoreLevels: 10,
    maxRequestBytes: null,
    clock: fixedClock(CLOCK_NOW),
  });
}

const MEDIA_GRAPH: ApiGraph = {
  "3": {
    class_type: "KSampler",
    inputs: { seed: 1, steps: 20, latent_image: ["5", 0], model: ["4", 0] },
  },
  "4": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "x.safetensors" },
  },
  "5": {
    class_type: "EmptyLatentImage",
    inputs: { width: 512, height: 512, batch_size: 1 },
  },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
  "9": {
    class_type: "SaveImage",
    inputs: { filename_prefix: "ComfyUI", images: ["8", 0] },
  },
};

function mediaMapping(): WorkflowNodeMapping {
  return {
    workflow: "poster-v1",
    graphDigest: digestGraph(MEDIA_GRAPH),
    inputs: {
      prompt: { node: "6", key: "text" },
      negative: { node: "7", key: "text" },
      width: { node: "5", key: "width" },
      height: { node: "5", key: "height" },
      seed: { node: "3", key: "seed" },
    },
    outputs: ["9"],
  };
}

function mediaInput(): ImageGenerateInput {
  return {
    prompt: "a poster",
    negative: "blurry",
    width: 512,
    height: 768,
    seed: 42,
  };
}

function mediaAdapter(
  baseUrl: string,
  timeoutMs = 5000,
): ComfyUINativeAdapter {
  return new ComfyUINativeAdapter({
    baseUrl,
    timeoutMs,
    maxBodyBytes: 1_000_000,
    graph: MEDIA_GRAPH,
    mapping: mediaMapping(),
    clientId: "test-binding",
    maxDownloadBytes: 1_000_000,
    maxOutputs: 8,
  });
}

// The bridge serves one playback seed over node:http: it translates
// each incoming (method, path, headers, body) into a fetch Request
// against `http://<seed host>` and streams the playback Response
// back, so the real adapters run unmodified on top.

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

async function startBridge(
  host: string,
  handler: Pick<PlaybackHandler, "fetch">,
): Promise<Bridge> {
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(
            typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer),
          );
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
        const response = await handler.fetch(
          new Request(`http://${host}${req.url ?? "/"}`, init),
        );
        // NB: no `req.destroyed` early-return here — Node marks a
        // fully-read request destroyed, so that check misfires on
        // every request. A truly gone client surfaces as a write
        // failure below, which is tolerated like the harness.
        // The adapters read status, body bytes, content-type (binary
        // downloads) and location (redirects); nothing else crosses.
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
    close: () =>
      new Promise<void>((resolveClose) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolveClose());
      }),
  };
}

// Per-table adapter flows, mirroring scenarios.test.ts: the same
// operation(s), delivery/job ids and short timeouts per scenario, so
// both sides of each differential run take identical adapter paths.

async function mailFlow(scenario: string, baseUrl: string): Promise<unknown> {
  switch (scenario) {
    case "send-ok":
    case "send-reject":
    case "send-rate-limited":
    case "send-client-timeout":
    case "send-invalid-schema":
    case "send-redirect-refused":
    case "send-redirect-loop":
      return await mailAdapter(baseUrl).send(mailInput(), {
        deliveryId: "del_1",
      });
    case "send-retry-success": {
      const adapter = mailAdapter(baseUrl);
      const first = await adapter.send(mailInput(), { deliveryId: "del_1" });
      const second = await adapter.send(mailInput(), { deliveryId: "del_1" });
      return [first, second];
    }
    case "send-unknown-accepted":
    case "send-unknown-rejected":
    case "send-unknown-pending": {
      const adapter = mailAdapter(baseUrl, 50);
      const lost = await adapter.send(mailInput(), { deliveryId: "del_1" });
      const found = await adapter.reconcile("del_1");
      return [lost, found];
    }
    default:
      throw new Error(`no playback flow for mail:${scenario}`);
  }
}

async function modelsFlow(scenario: string, baseUrl: string): Promise<unknown> {
  switch (scenario) {
    case "generate-ok":
    case "generate-reject":
    case "generate-transient":
    case "generate-rate-limited":
    case "generate-invalid-schema":
      return await modelsAdapter(baseUrl).generate(modelsInput(), {
        deliveryId: "del_1",
      });
    case "generate-timeout-unknown": {
      const adapter = modelsAdapter(baseUrl, 100);
      const completion = await adapter.generate(modelsInput(), {
        deliveryId: "del_1",
      });
      const reconciled = await adapter.reconcile("del_1");
      return [completion, reconciled];
    }
    case "stream-ok":
    case "stream-mid-error":
    case "stream-truncated": {
      const run = modelsAdapter(baseUrl).generateStream(modelsInput(), {
        deliveryId: "del_9",
      });
      const done = await run.done();
      return { done, snapshots: run.snapshots() };
    }
    case "stream-cancel": {
      const run = modelsAdapter(baseUrl).generateStream(modelsInput(), {
        deliveryId: "del_9",
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const cancelled = await run.cancel();
      return { cancelled, snapshots: run.snapshots() };
    }
    default:
      throw new Error(`no playback flow for models:${scenario}`);
  }
}

async function judgmentsFlow(
  scenario: string,
  baseUrl: string,
): Promise<unknown> {
  switch (scenario) {
    case "evaluate-ok":
    case "evaluate-reject":
    case "evaluate-unauthorized":
    case "evaluate-rate-limited":
    case "evaluate-transient":
    case "evaluate-invalid-schema":
      return await judgmentsAdapter(baseUrl).evaluate(judgmentsInput(), {
        deliveryId: "del_1",
      });
    case "evaluate-timeout-unknown": {
      const adapter = judgmentsAdapter(baseUrl, 100);
      const completion = await adapter.evaluate(judgmentsInput(), {
        deliveryId: "del_1",
      });
      const reconciled = await adapter.reconcile("del_1");
      return [completion, reconciled];
    }
    default:
      throw new Error(`no playback flow for judgments:${scenario}`);
  }
}

async function mediaFlow(scenario: string, baseUrl: string): Promise<unknown> {
  switch (scenario) {
    case "submit-ok":
    case "submit-reject":
    case "submit-transient":
      return await mediaAdapter(baseUrl).submit(mediaInput(), {
        deliveryId: "del_1",
        jobId: "job_1",
      });
    case "submit-unknown-recover": {
      const adapter = mediaAdapter(baseUrl, 100);
      const submitted = await adapter.submit(mediaInput(), {
        deliveryId: "del_1",
        jobId: "job_7",
      });
      const recovered = await adapter.reconcile("job_7", {
        deliveryId: "del_1",
      });
      return [submitted, recovered];
    }
    case "run-succeeded":
    case "run-running":
    case "run-queued-unknown":
    case "run-failed-partial":
    case "run-failed-detail":
    case "run-malformed":
    case "run-bytes-missing":
      return await mediaAdapter(baseUrl).reconcile("job_1", {
        deliveryId: "del_1",
      });
    case "poll-timeout":
      return await mediaAdapter(baseUrl, 100).reconcile("job_1", {
        deliveryId: "del_1",
      });
    case "cancel-observed":
      return await mediaAdapter(baseUrl).cancel("job_1", {
        deliveryId: "del_1",
      });
    default:
      throw new Error(`no playback flow for media:${scenario}`);
  }
}

async function runTableFlow(
  table: ScenarioTable,
  baseUrl: string,
): Promise<unknown> {
  switch (table.provider) {
    case "mail":
      return await mailFlow(table.scenario, baseUrl);
    case "models":
      return await modelsFlow(table.scenario, baseUrl);
    case "judgments":
      return await judgmentsFlow(table.scenario, baseUrl);
    case "media":
      return await mediaFlow(table.scenario, baseUrl);
  }
}

async function startHarness(table: ScenarioTable): Promise<Bridge> {
  switch (table.provider) {
    case "mail": {
      const server = await startControlledMailServer(
        checkMailScript(parseScenarioTable(table).script),
      );
      return { url: server.url, close: () => server.close() };
    }
    case "models": {
      const server = await startControlledOllamaServer(
        checkModelsScript(parseScenarioTable(table).script),
      );
      return { url: server.url, close: () => server.close() };
    }
    case "judgments": {
      const server = await startControlledSystemOneServer(
        checkJudgmentsScript(parseScenarioTable(table).script),
      );
      return { url: server.url, close: () => server.close() };
    }
    case "media": {
      const decoded = decodeMediaScript(parseScenarioTable(table).script);
      const server = await startControlledComfyServer(
        decoded.scenario,
        decoded.cancelStatus === undefined
          ? undefined
          : { cancelStatus: decoded.cancelStatus },
      );
      return { url: server.url, close: () => server.close() };
    }
  }
}

/** Normalize adapter outcomes for comparison (bytes travel as hex). */
function normalizeOutcome(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("hex") };
  }
  if (Array.isArray(value)) {
    return value.map(normalizeOutcome);
  }
  if (typeof value === "object" && value !== null) {
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      record[key] = normalizeOutcome(
        (value as Record<string, unknown>)[key],
      );
    }
    return record;
  }
  return value;
}

interface StreamCancelOutcome {
  readonly cancelled: unknown;
  readonly snapshots: ReadonlyArray<{
    readonly sequence: number;
    readonly state: string;
    readonly content: string;
  }>;
}

/**
 * stream-cancel compares semantically, not exactly: both sides cancel
 * a paced run 120ms in, so snapshot COUNTS may differ by scheduling
 * jitter. The cancelled completion is deterministic, the first line
 * always arrives immediately, and both runs end cancelled.
 */
function expectStreamCancelEquivalent(
  expected: unknown,
  actual: unknown,
): void {
  const e = expected as StreamCancelOutcome;
  const a = actual as StreamCancelOutcome;
  expect(normalizeOutcome(a.cancelled)).toEqual(
    normalizeOutcome(e.cancelled),
  );
  for (const outcome of [e, a]) {
    const completion = outcome.cancelled as {
      status: string;
      error?: { code: string };
    };
    expect(completion.status).toBe("failed");
    expect(completion.error?.code).toBe("run_cancelled");
    expect(outcome.snapshots.length).toBeGreaterThan(0);
    const last = outcome.snapshots[outcome.snapshots.length - 1];
    expect(last?.state).toBe("cancelled");
  }
  expect(a.snapshots[0]?.content).toBe(e.snapshots[0]?.content);
}

describe("playback differential conformance", () => {
  const covered = new Set<string>();

  for (const table of SCENARIO_TABLES) {
    const seed = `${table.provider}:${table.scenario}`;
    it(`matches the harness for ${seed}`, async () => {
      covered.add(seed);
      const harness = await startHarness(table);
      try {
        const expected = await runTableFlow(table, harness.url);
        const handler = createPlaybackHandler([table]);
        const bridge = await startBridge(
          `${table.scenario}.${table.provider}.playback`,
          handler,
        );
        try {
          const actual = await runTableFlow(table, bridge.url);
          if (seed === "models:stream-cancel") {
            expectStreamCancelEquivalent(expected, actual);
          } else {
            expect(normalizeOutcome(actual)).toEqual(
              normalizeOutcome(expected),
            );
          }
        } finally {
          await bridge.close();
        }
      } finally {
        await harness.close();
      }
    }, 15000);
  }

  it("covers the full 41-table catalog", () => {
    expect(SCENARIO_TABLES.length).toBe(41);
    expect(covered.size).toBe(41);
  });
});

describe("playback fail-loud", () => {
  it("500s unknown seeds, naming the seed", async () => {
    const handler = createPlaybackHandler(SCENARIO_TABLES);
    const unknown = await handler.fetch(
      new Request("http://nope.mail.playback/send", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(unknown.status).toBe(500);
    const unknownBody = (await unknown.json()) as { error: string };
    expect(unknownBody.error).toContain("mail:nope");
    const wrongProvider = await handler.fetch(
      new Request("http://send-ok.files.playback/send", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(wrongProvider.status).toBe(500);
    const wrongBody = (await wrongProvider.json()) as { error: string };
    expect(wrongBody.error).toContain("files:send-ok");
  });

  it("500s malformed hosts", async () => {
    const handler = createPlaybackHandler(SCENARIO_TABLES);
    for (const host of [
      "localhost",
      "mail.playback",
      "a.b.c.playback",
      ".mail.playback",
    ]) {
      const response = await handler.fetch(
        new Request(`http://${host}/send`, { method: "POST", body: "{}" }),
      );
      expect(response.status).toBe(500);
    }
  });

  it("preserves owning first errors and distinct base64 decode profiles", () => {
    const cases = [
      { provider: "mail", script: { kind: "nope", extra: true }, message: 'mail script has an unknown kind "nope".' },
      { provider: "mail", script: { kind: "reject", status: 99, extra: true }, message: 'mail script has an unknown key "extra".' },
      { provider: "mail", script: { kind: "reject", status: 99, body: NaN }, message: 'mail script.body must be finite JSON.' },
      { provider: "models", script: { kind: "stream", lines: [], lineDelayMs: -1 }, message: 'models stream lineDelayMs must be a finite delay >= 0.' },
      { provider: "judgments", script: { kind: "reject", status: 99 }, message: 'judgments reject status must be an integer HTTP status.' },
      { provider: "media", script: { kind: "reject-prompt", status: 99, cancelStatus: 99 }, message: 'media cancelStatus must be an integer HTTP status.' },
    ];
    for (const { provider, script, message } of cases) {
      const table = { provider, scenario: "bad-profile", script };
      expect(() => parseScenarioTable(table)).toThrowError(new ScenarioTableError(message));
      expect(() => createPlaybackHandler([table])).toThrowError(new PlaybackScriptError(message));
      try { parseScenarioTable(table); } catch (error) { expect(error).toBeInstanceOf(ScenarioTableError); }
      try { createPlaybackHandler([table]); } catch (error) { expect(error).toBeInstanceOf(PlaybackScriptError); }
    }
    const script = { kind: "accept", filesBase64: { "a.png": "A===" } };
    // This alphabet mismatch is caught before either owning decoder runs.
    expect(() => decodeMediaScript(script)).toThrowError('must be base64');
    expect(() => createPlaybackHandler([{ provider: "media", scenario: "bad-base64", script }])).toThrowError('must be base64');
    const noncanonical = { kind: "accept", filesBase64: { "a.png": "AB==" } };
    expect(() => decodeMediaScript(noncanonical)).toThrowError('must be canonical base64');
    expect(() => createPlaybackHandler([{ provider: "media", scenario: "bad-base64", script: noncanonical }])).toThrowError('must be canonical base64');
    const misplaced = { kind: "accept", filesBase64: { "a.png": "AA==" } };
    expect(decodeMediaScript(misplaced).scenario.kind).toBe("accept");
    expect(() => createPlaybackHandler([{ provider: "media", scenario: "base64-ok", script: misplaced }])).not.toThrow();
  });

  it("throws PlaybackScriptError on invalid scripts", () => {
    expect(() =>
      createPlaybackHandler([
        {
          provider: "mail",
          scenario: "bad-kind",
          script: { kind: "nope" },
        },
      ]),
    ).toThrow(PlaybackScriptError);
    expect(() =>
      createPlaybackHandler([
        {
          provider: "models",
          scenario: "bad-stream",
          script: { kind: "stream" },
        },
      ]),
    ).toThrow(PlaybackScriptError);
    expect(() =>
      createPlaybackHandler([
        {
          provider: "judgments",
          scenario: "bad-reject",
          script: { kind: "reject", status: 500 },
        },
      ]),
    ).toThrow(PlaybackScriptError);
    expect(() =>
      createPlaybackHandler([
        {
          provider: "media",
          scenario: "bad-base64",
          script: { kind: "accept", filesBase64: { "a.png": "!!!" } },
        },
      ]),
    ).toThrow(PlaybackScriptError);
    expect(() =>
      createPlaybackHandler([
        {
          provider: "media",
          scenario: "bad-keys",
          script: { kind: "accept", files: {} },
        },
      ]),
    ).toThrow(PlaybackScriptError);
    expect(() =>
      createPlaybackHandler([
        mustTable("mail", "send-ok"),
        mustTable("mail", "send-ok"),
      ]),
    ).toThrow(PlaybackScriptError);
    expect(() =>
      createPlaybackHandler([
        {
          provider: "mail",
          scenario: "extra-key",
          script: { kind: "accept" },
          extra: true,
        } as unknown as ScenarioTable,
      ]),
    ).toThrow(PlaybackScriptError);
    expect(() =>
      createPlaybackHandler([null as unknown as ScenarioTable]),
    ).toThrow(PlaybackScriptError);
    expect(() =>
      createPlaybackHandler(["mail:send-ok" as unknown as ScenarioTable]),
    ).toThrow(PlaybackScriptError);
  });
});

describe("playback logs", () => {
  it("records mail sends with idempotent redelivery visible", async () => {
    const handler = createPlaybackHandler([mustTable("mail", "send-ok")]);
    const bridge = await startBridge("send-ok.mail.playback", handler);
    try {
      const adapter = mailAdapter(bridge.url);
      const first = await adapter.send(mailInput(), { deliveryId: "del_1" });
      const second = await adapter.send(mailInput(), { deliveryId: "del_1" });
      // Idempotent replay: the same key returns the original
      // reference without incrementing the counter.
      expect(first).toEqual(second);
      expect(first).toMatchObject({
        status: "succeeded",
        result: { reference: "mail_1" },
      });
      const entries = handler.log("mail:send-ok");
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        method: "POST",
        path: "/send",
        idempotencyKey: "del_1",
        hadAuth: false,
      });
      const logged = await handler.fetch(
        new Request("http://send-ok.mail.playback/__playback/log"),
      );
      expect(logged.status).toBe(200);
      const loggedEntries = (await logged.json()) as Array<
        Record<string, unknown>
      >;
      expect(loggedEntries).toHaveLength(2);
      expect(handler.mediaPrompts()).toEqual([]);
    } finally {
      await bridge.close();
    }
  });

  it("records media prompts in order", async () => {
    const handler = createPlaybackHandler([mustTable("media", "submit-ok")]);
    const bridge = await startBridge("submit-ok.media.playback", handler);
    try {
      const completion = await mediaAdapter(bridge.url).submit(mediaInput(), {
        deliveryId: "del_1",
        jobId: "job_9",
      });
      expect(completion.status).toBe("succeeded");
      expect(handler.mediaPrompts()).toEqual(["job_9"]);
      const logged = await handler.fetch(
        new Request("http://submit-ok.media.playback/__playback/log"),
      );
      expect(logged.status).toBe(200);
      const loggedEntries = (await logged.json()) as Array<
        Record<string, unknown>
      >;
      expect(loggedEntries).toHaveLength(1);
      expect(loggedEntries[0]).toMatchObject({
        method: "POST",
        path: "/prompt",
      });
    } finally {
      await bridge.close();
    }
  });

  it("fails loud on unknown seeds for log accessors", async () => {
    const handler = createPlaybackHandler([mustTable("mail", "send-ok")]);
    expect(() => handler.log("mail:nope")).toThrow(/unknown seed/);
    const logged = await handler.fetch(
      new Request("http://nope.mail.playback/__playback/log"),
    );
    expect(logged.status).toBe(500);
  });
});

describe("playback non-catalog paths", () => {
  it("serves drip bodies after the delay", async () => {
    const handler = createPlaybackHandler([
      {
        provider: "mail",
        scenario: "send-drip",
        script: { kind: "drip", delayMs: 50 },
      },
    ]);
    const started = Date.now();
    const response = await handler.fetch(
      new Request("http://send-drip.mail.playback/send", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reference: "mail_drip" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it("serves the redirect-landing /send-final routes", async () => {
    const handler = createPlaybackHandler([
      {
        provider: "mail",
        scenario: "send-redirect-loop",
        script: { kind: "redirect", status: 307, location: "/send" },
      },
    ]);
    const posted = await handler.fetch(
      new Request("http://send-redirect-loop.mail.playback/send-final", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(posted.status).toBe(200);
    expect(await posted.json()).toEqual({ reference: "mail_1" });
    const fetched = await handler.fetch(
      new Request("http://send-redirect-loop.mail.playback/send-final"),
    );
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual({ reference: "mail_get" });
  });

  it("404s unknown deliveries", async () => {
    const handler = createPlaybackHandler([mustTable("mail", "send-ok")]);
    const response = await handler.fetch(
      new Request("http://send-ok.mail.playback/deliveries/never-sent"),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "unknown delivery" });
  });

  it("honors cancelStatus 404 and promptBody overrides", async () => {
    const noRoute = createPlaybackHandler([
      {
        provider: "media",
        scenario: "cancel-missing",
        script: { kind: "accept", cancelStatus: 404 },
      },
    ]);
    const cancelled = await noRoute.fetch(
      new Request("http://cancel-missing.media.playback/api/jobs/j/cancel", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(cancelled.status).toBe(404);
    expect(await cancelled.json()).toEqual({ error: "no such route" });

    const override = createPlaybackHandler([
      {
        provider: "media",
        scenario: "submit-ok",
        script: { kind: "accept", promptBody: { prompt_id: "custom" } },
      },
    ]);
    const submitted = await override.fetch(
      new Request("http://submit-ok.media.playback/prompt", {
        method: "POST",
        body: JSON.stringify({ prompt_id: "job_1" }),
      }),
    );
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toEqual({ prompt_id: "custom" });
    // The prompt id is still recorded even with an override body.
    expect(override.mediaPrompts()).toEqual(["job_1"]);
  });

  it("serves the models/judgments invalid-schema kinds", async () => {
    const models = createPlaybackHandler([
      {
        provider: "models",
        scenario: "generate-invalid-schema",
        script: { kind: "invalid-schema", body: { wrong: true } },
      },
    ]);
    const modelsRes = await models.fetch(
      new Request("http://generate-invalid-schema.models.playback/api/chat", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(modelsRes.status).toBe(200);
    expect(await modelsRes.json()).toEqual({ wrong: true });

    const judgments = createPlaybackHandler([
      {
        provider: "judgments",
        scenario: "evaluate-invalid-schema",
        script: { kind: "invalid-schema", body: { wrong: true } },
      },
    ]);
    const judgmentsRes = await judgments.fetch(
      new Request(
        "http://evaluate-invalid-schema.judgments.playback/v1/systemone",
        { method: "POST", body: "{}" },
      ),
    );
    expect(judgmentsRes.status).toBe(200);
    expect(await judgmentsRes.json()).toEqual({ wrong: true });
  });
});

describe("playback in workerd", () => {
  it(
    "serves mail + models seeds by hostname",
    async () => {
      const bundled = await bundleWorker({
        entryPoints: [
          fileURLToPath(
            new URL("../src/fixtures/playback-worker.ts", import.meta.url),
          ),
        ],
        bundle: true,
        format: "esm",
        platform: "neutral",
        write: false,
      });
      const contents = bundled.outputFiles[0]?.text;
      if (contents === undefined) {
        throw new Error("esbuild produced no worker bundle");
      }
      expect(contents).not.toContain("node:");
      const worker = new Miniflare({
        name: "playback-smoke",
        compatibilityDate: "2026-07-15",
        modules: [{ type: "ESModule", path: "worker.mjs", contents }],
      });
      try {
        const beforeLoad = await worker.dispatchFetch(
          "http://send-ok.mail.playback/send",
          { method: "POST", body: "{}" },
        );
        expect(beforeLoad.status).toBe(500);
        const loadRes = await worker.dispatchFetch(
          "http://playback.local/__playback/load",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              tables: [
                mustTable("mail", "send-ok"),
                mustTable("models", "generate-ok"),
              ],
            }),
          },
        );
        expect(loadRes.status).toBe(200);
        expect(await loadRes.json()).toEqual({ loaded: 2 });
        const mailRes = await worker.dispatchFetch(
          "http://send-ok.mail.playback/send",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": "del_1",
            },
            body: JSON.stringify({ to: "reviewer@example.test" }),
          },
        );
        expect(mailRes.status).toBe(200);
        expect(await mailRes.json()).toEqual({ reference: "mail_1" });

        const modelsRes = await worker.dispatchFetch(
          "http://generate-ok.models.playback/api/chat",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: MODELS_MODEL,
              messages: [{ role: "user", content: "Hello" }],
              stream: false,
            }),
          },
        );
        expect(modelsRes.status).toBe(200);
        const modelsBody = (await modelsRes.json()) as { model: string };
        expect(modelsBody.model).toBe(MODELS_MODEL);

        const missing = await worker.dispatchFetch(
          "http://nope.mail.playback/send",
          { method: "POST", body: "{}" },
        );
        expect(missing.status).toBe(500);
      } finally {
        await worker.dispose();
      }
    },
    120000,
  );
});
