/**
 * Scenario-table playback endpoint (L7 S8d-playback): serves L4's
 * authored scenario tables through a fetch-Handler, replicating the
 * four `node:http` harness servers request-for-request.
 *
 * The harness code is the normative spec; this module mirrors it:
 * - mail: `packages/services/src/ports.ts` (`startControlledMailServer`)
 * - models: `packages/services/src/models/harness.ts`
 * - judgments: `packages/services/src/judgments/harness.ts`
 * - media: `packages/services/src/media/harness.ts`
 *
 * Routing is by hostname — `<scenario>.<provider>.playback` — because
 * the adapters resolve absolute paths against the base URL (origin
 * only) over the global fetch. Unknown hosts or seeds fail LOUD
 * (HTTP 500 naming the seed); there is no default script.
 *
 * Workerd-safe: no `node:` imports, no Buffer. Base64 uses the
 * `atob`/`btoa` globals (present in workerd and node 22+).
 *
 * This module imports NOTHING from services source — not even types.
 * `@canlang/services` has no build, and TS-source imports break both
 * the testkit emit (`rootDir` violation) and the root strict check
 * (L4's local flags fall short of workspace strictness; hardening
 * requested). The script/table shapes below mirror L4's
 * `Controlled*` contracts structurally, and the differential suite
 * feeds the REAL `SCENARIO_TABLES` through this handler, so any L4
 * shape drift fails loudly at runtime (unknown kind/key) instead of
 * slipping through. When services gains a build, prefer its package
 * exports (same precedent as the S8b files pin).
 */

import { parseSeedRef } from "./seeds.js";

/**
 * Fail-closed table/script errors. Mirrors L4's `PlaybackScriptError`
 * semantics without importing services source (see header).
 */
export class PlaybackScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaybackScriptError";
  }
}

/** One scenario table: mirrors L4's `ScenarioTable` structurally. */
export interface PlaybackScenarioTable {
  readonly provider: string;
  readonly scenario: string;
  readonly script: unknown;
}

/** Mirrors L4's mail `ControlledScenario` (`ports.ts`). */
export type MailScript =
  | { readonly kind: "accept" }
  | { readonly kind: "reject"; readonly status: number; readonly body: unknown }
  | { readonly kind: "flaky-then-accept"; readonly failures: number }
  | { readonly kind: "invalid-schema"; readonly body: unknown }
  | {
      readonly kind: "hang";
      readonly reconcile: "accepted" | "rejected" | "pending";
    }
  | {
      readonly kind: "redirect";
      readonly status: number;
      readonly location: string;
    }
  | { readonly kind: "drip"; readonly delayMs: number };

/** Mirrors L4's `ControlledOllamaScenario` (`models/harness.ts`). */
export type ModelsScript =
  | { readonly kind: "final"; readonly body: unknown }
  | {
      readonly kind: "stream";
      readonly lines: readonly unknown[];
      readonly lineDelayMs?: number;
    }
  | { readonly kind: "reject"; readonly status: number; readonly body: unknown }
  | { readonly kind: "hang" }
  | { readonly kind: "invalid-schema"; readonly body: unknown };

/** Mirrors L4's `ControlledSystemOneScenario` (`judgments/harness.ts`). */
export type JudgmentsScript =
  | { readonly kind: "accept"; readonly body: unknown }
  | { readonly kind: "reject"; readonly status: number; readonly body: unknown }
  | { readonly kind: "hang" }
  | { readonly kind: "invalid-schema"; readonly body: unknown };

/** One logged request, shaped as the union of the four harness logs. */
export interface PlaybackLogEntry {
  readonly method: string;
  readonly path: string;
  readonly bodyText: string;
  readonly hadAuth: boolean;
  readonly idempotencyKey: string | null;
  readonly stream?: boolean | null;
  readonly model?: string | null;
  readonly questionIds?: readonly string[] | null;
}

export interface PlaybackHandler {
  readonly fetch: (req: Request) => Promise<Response>;
  readonly log: (seed: string) => readonly PlaybackLogEntry[];
  readonly mediaPrompts: () => readonly string[];
}

/**
 * Same request-body cap as every harness (`MAX_HARNESS_BODY`), counted
 * in UTF-16 chars after the full read where the harnesses count bytes
 * during streaming. Diverges only for bodies over 4MB bytes yet under
 * 4M chars; adapters cap accepted bodies at 1MB, so no catalog table
 * or adapter-visible flow can tell the difference. (PR22 review N1.)
 */
const MAX_BODY_CHARS = 4_000_000;

async function readCappedBody(req: Request): Promise<string> {
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) {
    // Mirrors the harness body-too-large path: the server wrapper
    // answers 500 `harness failure`.
    throw new Error("playback body too large");
  }
  return text;
}

/** Mail/models/judgments body rule: strings raw, everything else JSON. */
function sendBodyResponse(status: number, value: unknown): Response {
  if (typeof value === "string") {
    return new Response(value, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Media body rule (`sendJson`): always JSON, even for strings. */
function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function neverResponds(): Promise<Response> {
  return new Promise<Response>(() => {
    // Hang scenarios never settle; the client must time out.
  });
}

// Media script validation mirrors `decodeMediaScript`
// (`scenarios.ts`) with identical strictness, but decodes base64 via
// `atob`/`btoa` instead of node Buffer so it runs in workerd.

type PlaybackMediaScenario =
  | {
      readonly kind: "accept";
      readonly history: Readonly<Record<string, unknown>>;
      readonly files: Readonly<Record<string, Uint8Array>>;
      readonly promptBody?: unknown;
    }
  | {
      readonly kind: "reject-prompt";
      readonly status: number;
      readonly body: unknown;
    }
  | {
      readonly kind: "hang-submit";
      readonly history: Readonly<Record<string, unknown>>;
      readonly files: Readonly<Record<string, Uint8Array>>;
    }
  | { readonly kind: "hang-all" };

interface PlaybackMediaScript {
  readonly scenario: PlaybackMediaScenario;
  readonly cancelStatus: number | undefined;
}

const MEDIA_KINDS: ReadonlySet<string> = new Set([
  "accept",
  "reject-prompt",
  "hang-submit",
  "hang-all",
]);

const MEDIA_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  "accept": new Set([
    "kind",
    "history",
    "filesBase64",
    "promptBody",
    "cancelStatus",
  ]),
  "reject-prompt": new Set(["kind", "status", "body", "cancelStatus"]),
  "hang-submit": new Set(["kind", "history", "filesBase64", "cancelStatus"]),
  "hang-all": new Set(["kind", "cancelStatus"]),
};

const MEDIA_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function playbackRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlaybackScriptError(`${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function playbackKind(
  record: Record<string, unknown>,
  what: string,
  kinds: ReadonlySet<string>,
): string {
  if (typeof record["kind"] !== "string" || !kinds.has(record["kind"])) {
    throw new PlaybackScriptError(
      `${what} has an unknown kind ${JSON.stringify(record["kind"])}.`,
    );
  }
  return record["kind"];
}

function playbackKeys(
  record: Record<string, unknown>,
  what: string,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new PlaybackScriptError(
        `${what} has an unknown key ${JSON.stringify(key)}.`,
      );
    }
  }
}

function playbackStatus(value: unknown, what: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 100 ||
    value > 599
  ) {
    throw new PlaybackScriptError(`${what} must be an integer HTTP status.`);
  }
  return value;
}

function playbackJsonSafe(value: unknown, what: string): void {
  const seen = new Set<object>();
  const visit = (node: unknown, path: string): void => {
    if (node === null) return;
    switch (typeof node) {
      case "string":
      case "boolean":
        return;
      case "number":
        if (!Number.isFinite(node)) {
          throw new PlaybackScriptError(`${what}${path} must be finite JSON.`);
        }
        return;
      case "undefined":
      case "function":
      case "symbol":
      case "bigint":
        throw new PlaybackScriptError(`${what}${path} is not JSON-safe.`);
      case "object": {
        if (seen.has(node)) {
          throw new PlaybackScriptError(`${what}${path} is cyclic.`);
        }
        seen.add(node);
        if (Array.isArray(node)) {
          node.forEach((entry, index) => visit(entry, `${path}[${index}]`));
          return;
        }
        for (const [key, entry] of Object.entries(node)) {
          visit(entry, `${path}.${key}`);
        }
        return;
      }
    }
  };
  visit(value, "");
}

/** Strict standard-base64 check with a verified round-trip. */
function decodePlaybackBase64File(
  value: unknown,
  filename: string,
): Uint8Array {
  if (typeof value !== "string" || value.length % 4 !== 0) {
    throw new PlaybackScriptError(
      `media filesBase64[${JSON.stringify(filename)}] must be base64.`,
    );
  }
  if (value !== "" && !MEDIA_BASE64_PATTERN.test(value)) {
    throw new PlaybackScriptError(
      `media filesBase64[${JSON.stringify(filename)}] must be base64.`,
    );
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    // Pattern-passing but undecodable input (e.g. misplaced `=`):
    // map to the local error like L4 maps everything to
    // `ScenarioTableError`. Unreachable from the real catalog.
    // (PR22 review N2.)
    throw new PlaybackScriptError(
      `media filesBase64[${JSON.stringify(filename)}] must be base64.`,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index) & 0xff;
  }
  if (btoa(binary) !== value) {
    throw new PlaybackScriptError(
      `media filesBase64[${JSON.stringify(filename)}] must be canonical base64.`,
    );
  }
  return bytes;
}

function decodePlaybackMediaScript(script: unknown): PlaybackMediaScript {
  const record = playbackRecord(script, "media script");
  const kind = playbackKind(record, "media script", MEDIA_KINDS);
  playbackKeys(record, "media script", MEDIA_KEYS[kind] ?? new Set(["kind"]));
  playbackJsonSafe(record, "media script");
  let history: Readonly<Record<string, unknown>> = {};
  if (record["history"] !== undefined) {
    history = playbackRecord(record["history"], "media history");
  }
  let files: Readonly<Record<string, Uint8Array>> = {};
  if (record["filesBase64"] !== undefined) {
    const encoded = playbackRecord(record["filesBase64"], "media filesBase64");
    const decoded: Record<string, Uint8Array> = {};
    for (const [filename, value] of Object.entries(encoded)) {
      decoded[filename] = decodePlaybackBase64File(value, filename);
    }
    files = decoded;
  }
  let cancelStatus: number | undefined;
  if (record["cancelStatus"] !== undefined) {
    cancelStatus = playbackStatus(record["cancelStatus"], "media cancelStatus");
  }
  if (kind === "reject-prompt") {
    playbackStatus(record["status"], "media reject-prompt status");
    if (!("body" in record)) {
      throw new PlaybackScriptError("media reject-prompt needs a body.");
    }
    return {
      scenario: {
        kind: "reject-prompt",
        status: record["status"] as number,
        body: record["body"],
      },
      cancelStatus,
    };
  }
  if (kind === "hang-submit") {
    return { scenario: { kind: "hang-submit", history, files }, cancelStatus };
  }
  if (kind === "accept") {
    const scenario: PlaybackMediaScenario =
      record["promptBody"] !== undefined
        ? { kind: "accept", history, files, promptBody: record["promptBody"] }
        : { kind: "accept", history, files };
    return { scenario, cancelStatus };
  }
  return { scenario: { kind: "hang-all" }, cancelStatus };
}

// Mail/models/judgments validation mirrors L4's `checkMailScript`/
// `checkModelsScript`/`checkJudgmentsScript` (`scenarios.ts`) with
// identical strictness, minus the services import (see header).

function playbackDelay(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PlaybackScriptError(`${what} must be a finite delay >= 0.`);
  }
  return value;
}

const PLAYBACK_MAIL_KINDS: ReadonlySet<string> = new Set([
  "accept",
  "reject",
  "flaky-then-accept",
  "invalid-schema",
  "hang",
  "redirect",
  "drip",
]);

const PLAYBACK_MAIL_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  "accept": new Set(["kind"]),
  "reject": new Set(["kind", "status", "body"]),
  "flaky-then-accept": new Set(["kind", "failures"]),
  "invalid-schema": new Set(["kind", "body"]),
  "hang": new Set(["kind", "reconcile"]),
  "redirect": new Set(["kind", "status", "location"]),
  "drip": new Set(["kind", "delayMs"]),
};

const PLAYBACK_MAIL_RECONCILE: ReadonlySet<string> = new Set([
  "accepted",
  "rejected",
  "pending",
]);

function checkPlaybackMailScript(script: unknown): MailScript {
  const record = playbackRecord(script, "mail script");
  const kind = playbackKind(record, "mail script", PLAYBACK_MAIL_KINDS);
  playbackKeys(
    record,
    "mail script",
    PLAYBACK_MAIL_KEYS[kind] ?? new Set(["kind"]),
  );
  playbackJsonSafe(record, "mail script");
  switch (kind) {
    case "reject":
      playbackStatus(record["status"], "mail reject status");
      if (!("body" in record)) {
        throw new PlaybackScriptError("mail reject needs a body.");
      }
      break;
    case "flaky-then-accept": {
      const failures = record["failures"];
      if (
        typeof failures !== "number" ||
        !Number.isInteger(failures) ||
        failures < 0
      ) {
        throw new PlaybackScriptError(
          "mail flaky failures must be an integer >= 0.",
        );
      }
      break;
    }
    case "invalid-schema":
      if (!("body" in record)) {
        throw new PlaybackScriptError("mail invalid-schema needs a body.");
      }
      break;
    case "hang":
      if (
        typeof record["reconcile"] !== "string" ||
        !PLAYBACK_MAIL_RECONCILE.has(record["reconcile"])
      ) {
        throw new PlaybackScriptError(
          "mail hang reconcile must be accepted, rejected or pending.",
        );
      }
      break;
    case "redirect":
      playbackStatus(record["status"], "mail redirect status");
      if (
        typeof record["location"] !== "string" ||
        record["location"] === ""
      ) {
        throw new PlaybackScriptError("mail redirect needs a location.");
      }
      break;
    case "drip":
      playbackDelay(record["delayMs"], "mail drip delayMs");
      break;
  }
  return record as unknown as MailScript;
}

const PLAYBACK_MODELS_KINDS: ReadonlySet<string> = new Set([
  "final",
  "stream",
  "reject",
  "hang",
  "invalid-schema",
]);

const PLAYBACK_MODELS_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  "final": new Set(["kind", "body"]),
  "stream": new Set(["kind", "lines", "lineDelayMs"]),
  "reject": new Set(["kind", "status", "body"]),
  "hang": new Set(["kind"]),
  "invalid-schema": new Set(["kind", "body"]),
};

function checkPlaybackModelsScript(script: unknown): ModelsScript {
  const record = playbackRecord(script, "models script");
  const kind = playbackKind(record, "models script", PLAYBACK_MODELS_KINDS);
  playbackKeys(
    record,
    "models script",
    PLAYBACK_MODELS_KEYS[kind] ?? new Set(["kind"]),
  );
  playbackJsonSafe(record, "models script");
  switch (kind) {
    case "final":
    case "invalid-schema":
      if (!("body" in record)) {
        throw new PlaybackScriptError(`models ${kind} needs a body.`);
      }
      break;
    case "stream":
      if (!Array.isArray(record["lines"])) {
        throw new PlaybackScriptError("models stream needs a lines array.");
      }
      if (record["lineDelayMs"] !== undefined) {
        playbackDelay(record["lineDelayMs"], "models stream lineDelayMs");
      }
      break;
    case "reject":
      playbackStatus(record["status"], "models reject status");
      if (!("body" in record)) {
        throw new PlaybackScriptError("models reject needs a body.");
      }
      break;
  }
  return record as unknown as ModelsScript;
}

const PLAYBACK_JUDGMENTS_KINDS: ReadonlySet<string> = new Set([
  "accept",
  "reject",
  "hang",
  "invalid-schema",
]);

const PLAYBACK_JUDGMENTS_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  "accept": new Set(["kind", "body"]),
  "reject": new Set(["kind", "status", "body"]),
  "hang": new Set(["kind"]),
  "invalid-schema": new Set(["kind", "body"]),
};

function checkPlaybackJudgmentsScript(script: unknown): JudgmentsScript {
  const record = playbackRecord(script, "judgments script");
  const kind = playbackKind(
    record,
    "judgments script",
    PLAYBACK_JUDGMENTS_KINDS,
  );
  playbackKeys(
    record,
    "judgments script",
    PLAYBACK_JUDGMENTS_KEYS[kind] ?? new Set(["kind"]),
  );
  playbackJsonSafe(record, "judgments script");
  if (kind === "accept" || kind === "invalid-schema") {
    if (!("body" in record)) {
      throw new PlaybackScriptError(`judgments ${kind} needs a body.`);
    }
  }
  if (kind === "reject") {
    playbackStatus(record["status"], "judgments reject status");
    if (!("body" in record)) {
      throw new PlaybackScriptError("judgments reject needs a body.");
    }
  }
  return record as unknown as JudgmentsScript;
}

// Per-seed runtime state. Each seed behaves as its own harness
// server: mail counters/deliveries and media submit numbering are
// isolated per seed so one handler can serve the whole catalog.
// Prompt ids additionally append to one handler-wide list (in arrival
// order) backing `mediaPrompts()`.

interface MailSeedState {
  readonly provider: "mail";
  readonly script: MailScript;
  readonly log: PlaybackLogEntry[];
  readonly deliveries: Map<
    string,
    { outcome: "accepted" | "rejected" | "pending"; reference: string }
  >;
  counter: number;
  sendAttempts: number;
}

interface ModelsSeedState {
  readonly provider: "models";
  readonly script: ModelsScript;
  readonly log: PlaybackLogEntry[];
}

interface JudgmentsSeedState {
  readonly provider: "judgments";
  readonly script: JudgmentsScript;
  readonly log: PlaybackLogEntry[];
}

interface MediaSeedState {
  readonly provider: "media";
  readonly script: PlaybackMediaScript;
  readonly log: PlaybackLogEntry[];
  submitCount: number;
}

type SeedState = MailSeedState | ModelsSeedState | JudgmentsSeedState | MediaSeedState;

const SEED_PROVIDERS: ReadonlySet<string> = new Set([
  "mail",
  "models",
  "judgments",
  "media",
]);

const SEED_SCENARIO = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const PLAYBACK_TABLE_KEYS: ReadonlySet<string> = new Set([
  "provider",
  "scenario",
  "script",
]);

function checkSeedTable(table: PlaybackScenarioTable): {
  key: string;
  state: SeedState;
} {
  // Fail closed like L4's `checkRecord` before touching keys: null /
  // non-objects become `PlaybackScriptError`, never `TypeError`.
  // (PR23 review advisory 2.)
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    throw new PlaybackScriptError("scenario table must be an object.");
  }
  // Top-level allowlist mirrors L4's `TABLE_KEYS`: extra table keys
  // are rejected, never ignored. (PR22 review N3.)
  playbackKeys(
    table as unknown as Record<string, unknown>,
    "scenario table",
    PLAYBACK_TABLE_KEYS,
  );
  const provider: string = table.provider;
  const scenario: string = table.scenario;
  if (!SEED_PROVIDERS.has(provider)) {
    throw new PlaybackScriptError(
      `scenario table has an unknown provider ${JSON.stringify(provider)}.`,
    );
  }
  if (!SEED_SCENARIO.test(scenario)) {
    throw new PlaybackScriptError(
      `scenario table has an invalid scenario name ${JSON.stringify(scenario)}.`,
    );
  }
  const key = `${provider}:${scenario}`;
  switch (provider) {
    case "mail":
      return {
        key,
        state: {
          provider: "mail",
          script: checkPlaybackMailScript(table.script),
          log: [],
          deliveries: new Map(),
          counter: 0,
          sendAttempts: 0,
        },
      };
    case "models":
      return {
        key,
        state: {
          provider: "models",
          script: checkPlaybackModelsScript(table.script),
          log: [],
        },
      };
    case "judgments":
      return {
        key,
        state: {
          provider: "judgments",
          script: checkPlaybackJudgmentsScript(table.script),
          log: [],
        },
      };
    case "media":
      return {
        key,
        state: {
          provider: "media",
          script: decodePlaybackMediaScript(table.script),
          log: [],
          submitCount: 0,
        },
      };
    default:
      throw new PlaybackScriptError(
        `scenario table has an unknown provider ${JSON.stringify(provider)}.`,
      );
  }
}

function routeSeed(hostname: string): string | null {
  const labels = hostname.split(".");
  if (labels.length !== 3) {
    return null;
  }
  const scenario = labels[0];
  const provider = labels[1];
  const tail = labels[2];
  if (
    scenario === undefined ||
    scenario === "" ||
    provider === undefined ||
    provider === "" ||
    tail !== "playback"
  ) {
    return null;
  }
  return `${provider}:${scenario}`;
}

function mailAccept(
  state: MailSeedState,
  idempotencyKey: string | null,
): Response {
  // Idempotent: the same key returns the original reference — but
  // ONLY when the recorded outcome is accepted (rejected/pending
  // keys fall through to a NEW accept, exactly as the harness).
  if (idempotencyKey !== null) {
    const existing = state.deliveries.get(idempotencyKey);
    if (existing !== undefined && existing.outcome === "accepted") {
      return sendBodyResponse(200, { reference: existing.reference });
    }
  }
  state.counter += 1;
  const reference = `mail_${state.counter}`;
  state.deliveries.set(idempotencyKey ?? `anon_${state.counter}`, {
    outcome: "accepted",
    reference,
  });
  return sendBodyResponse(200, { reference });
}

/** Drip body: one JSON document delivered after `delayMs`. */
function delayedStream(text: string, delayMs: number): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        timer = undefined;
        try {
          controller.enqueue(encoded);
          controller.close();
        } catch {
          // Client already gone (e.g. timed out).
        }
      }, delayMs);
    },
    cancel() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  });
}

async function serveMail(
  state: MailSeedState,
  req: Request,
  rawPath: string,
): Promise<Response> {
  const method = req.method;
  if (method === "POST" && (rawPath === "/send" || rawPath === "/send-final")) {
    const bodyText = await readCappedBody(req);
    const idempotencyKey = req.headers.get("idempotency-key");
    state.log.push({
      method,
      path: rawPath,
      bodyText,
      hadAuth: req.headers.has("authorization"),
      idempotencyKey,
    });
    if (rawPath === "/send-final") {
      return mailAccept(state, idempotencyKey);
    }
    const script = state.script;
    switch (script.kind) {
      case "accept":
        return mailAccept(state, idempotencyKey);
      case "reject":
        return sendBodyResponse(script.status, script.body);
      case "flaky-then-accept":
        state.sendAttempts += 1;
        if (state.sendAttempts <= script.failures) {
          return sendBodyResponse(500, { error: "transient failure" });
        }
        return mailAccept(state, idempotencyKey);
      case "invalid-schema":
        return sendBodyResponse(200, script.body);
      case "hang": {
        // Possible commit: the send took effect server-side but the
        // response is lost, so the client must time out to unknown
        // and reconcile through the original identity.
        state.counter += 1;
        const reference = `mail_${state.counter}`;
        state.deliveries.set(idempotencyKey ?? `anon_${state.counter}`, {
          outcome: script.reconcile,
          reference,
        });
        return neverResponds();
      }
      case "redirect":
        return new Response(null, {
          status: script.status,
          headers: {
            location: script.location,
            "content-length": "0",
          },
        });
      case "drip": {
        const text = JSON.stringify({ reference: "mail_drip" });
        return new Response(delayedStream(text, script.delayMs), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      default: {
        const unreachable: never = script;
        throw new Error(`playback: unreachable mail kind ${String(unreachable)}`);
      }
    }
  }
  if (method === "GET" && rawPath === "/send-final") {
    // Same-origin 302 target: proves POST-to-GET conversion, since a
    // re-POST would return an acceptSend `mail_N` reference instead.
    return sendBodyResponse(200, { reference: "mail_get" });
  }
  if (method === "GET" && rawPath.startsWith("/deliveries/")) {
    const script = state.script;
    if (script.kind === "invalid-schema") {
      return sendBodyResponse(200, script.body);
    }
    const id = decodeURIComponent(rawPath.slice("/deliveries/".length));
    const record = state.deliveries.get(id);
    if (record === undefined) {
      return sendBodyResponse(404, { error: "unknown delivery" });
    }
    if (record.outcome === "pending") {
      return sendBodyResponse(200, { status: "pending" });
    }
    if (record.outcome === "accepted") {
      return sendBodyResponse(200, {
        status: "accepted",
        reference: record.reference,
      });
    }
    return sendBodyResponse(200, {
      status: "rejected",
      message: "No mailbox for recipient",
    });
  }
  return sendBodyResponse(404, { error: "not found" });
}

/**
 * NDJSON lines paced like the harness: the first line immediately,
 * each later line after `delayMs` (0 writes the whole stream at
 * once). Client cancels stop the pacing timers.
 */
function pacedLinesStream(
  lines: readonly string[],
  delayMs: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let index = 0;
  const pump = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (cancelled) {
      return;
    }
    if (index >= lines.length) {
      try {
        controller.close();
      } catch {
        // Client already gone.
      }
      return;
    }
    const line = lines[index] as string;
    index += 1;
    try {
      controller.enqueue(encoder.encode(`${line}\n`));
    } catch {
      return; // Client gone.
    }
    if (index >= lines.length) {
      try {
        controller.close();
      } catch {
        // Client already gone.
      }
      return;
    }
    if (delayMs > 0) {
      timer = setTimeout(() => {
        timer = undefined;
        pump(controller);
      }, delayMs);
    } else {
      pump(controller);
    }
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      pump(controller);
    },
    cancel() {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  });
}

async function serveModels(
  state: ModelsSeedState,
  req: Request,
  rawPath: string,
): Promise<Response> {
  if (req.method === "POST" && rawPath === "/api/chat") {
    const bodyText = await readCappedBody(req);
    let stream: boolean | null = null;
    let model: string | null = null;
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      if (typeof parsed["stream"] === "boolean") {
        stream = parsed["stream"];
      }
      if (typeof parsed["model"] === "string") {
        model = parsed["model"];
      }
    } catch {
      // Unparseable bodies are logged raw; the adapter is under test.
    }
    state.log.push({
      method: req.method,
      path: rawPath,
      bodyText,
      hadAuth: req.headers.has("authorization"),
      idempotencyKey: null,
      stream,
      model,
    });
    const script = state.script;
    switch (script.kind) {
      case "final":
        return sendBodyResponse(200, script.body);
      case "stream": {
        const lines = script.lines.map((line) =>
          typeof line === "string" ? line : (JSON.stringify(line) as string),
        );
        return new Response(
          pacedLinesStream(lines, script.lineDelayMs ?? 0),
          {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          },
        );
      }
      case "reject":
        return sendBodyResponse(script.status, script.body);
      case "hang":
        return neverResponds();
      case "invalid-schema":
        return sendBodyResponse(200, script.body);
      default: {
        const unreachable: never = script;
        throw new Error(`playback: unreachable models kind ${String(unreachable)}`);
      }
    }
  }
  return sendBodyResponse(404, { error: "not found" });
}

async function serveJudgments(
  state: JudgmentsSeedState,
  req: Request,
  rawPath: string,
): Promise<Response> {
  if (req.method === "POST" && rawPath === "/v1/systemone") {
    const bodyText = await readCappedBody(req);
    let model: string | null = null;
    let questionIds: readonly string[] | null = null;
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      if (typeof parsed["model"] === "string") {
        model = parsed["model"];
      }
      const questions = parsed["questions"];
      if (
        typeof questions === "object" &&
        questions !== null &&
        !Array.isArray(questions)
      ) {
        questionIds = Object.keys(questions);
      }
    } catch {
      // Unparseable bodies are logged raw; the adapter is under test.
    }
    state.log.push({
      method: req.method,
      path: rawPath,
      bodyText,
      hadAuth: req.headers.has("authorization"),
      idempotencyKey: null,
      model,
      questionIds,
    });
    const script = state.script;
    switch (script.kind) {
      case "accept":
        return sendBodyResponse(200, script.body);
      case "reject":
        return sendBodyResponse(script.status, script.body);
      case "hang":
        return neverResponds();
      case "invalid-schema":
        return sendBodyResponse(200, script.body);
      default: {
        const unreachable: never = script;
        throw new Error(
          `playback: unreachable judgments kind ${String(unreachable)}`,
        );
      }
    }
  }
  return sendBodyResponse(404, { error: "not found" });
}

async function serveMedia(
  state: MediaSeedState,
  prompts: string[],
  req: Request,
  url: URL,
  rawPath: string,
): Promise<Response> {
  const script = state.script;
  const scenario = script.scenario;
  if (scenario.kind === "hang-all") {
    return neverResponds(); // Never respond to anything — before any logging.
  }
  const method = req.method;
  const hadAuth = req.headers.has("authorization");
  if (method === "POST" && rawPath === "/prompt") {
    const bodyText = await readCappedBody(req);
    state.log.push({
      method,
      path: rawPath,
      bodyText,
      hadAuth,
      idempotencyKey: null,
    });
    if (scenario.kind === "reject-prompt") {
      return jsonResponse(scenario.status, scenario.body);
    }
    let promptId = `server_${state.submitCount + 1}`;
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      if (
        typeof parsed["prompt_id"] === "string" &&
        parsed["prompt_id"].length > 0
      ) {
        promptId = parsed["prompt_id"];
      }
    } catch {
      // Unparseable bodies are logged raw; the adapter is under test.
    }
    state.submitCount += 1;
    prompts.push(promptId);
    if (scenario.kind === "hang-submit") {
      return neverResponds(); // Recorded, but the response is lost.
    }
    if (scenario.promptBody !== undefined) {
      return jsonResponse(200, scenario.promptBody);
    }
    return jsonResponse(200, {
      prompt_id: promptId,
      number: state.submitCount,
    });
  }
  if (method === "GET" && rawPath.startsWith("/history/")) {
    state.log.push({
      method,
      path: rawPath,
      bodyText: "",
      hadAuth,
      idempotencyKey: null,
    });
    const id = decodeURIComponent(rawPath.slice("/history/".length));
    const history =
      scenario.kind === "accept" || scenario.kind === "hang-submit"
        ? scenario.history
        : {};
    const entry: unknown = history[id];
    if (entry === undefined) {
      return jsonResponse(200, {});
    }
    return jsonResponse(200, { [id]: entry });
  }
  if (method === "GET" && rawPath === "/view") {
    state.log.push({
      method,
      path: url.pathname + url.search,
      bodyText: "",
      hadAuth,
      idempotencyKey: null,
    });
    const filename = url.searchParams.get("filename") ?? "";
    const files =
      scenario.kind === "accept" || scenario.kind === "hang-submit"
        ? scenario.files
        : {};
    const bytes = files[filename];
    if (bytes === undefined) {
      return jsonResponse(404, { error: "no such file" });
    }
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }
  if (
    method === "POST" &&
    rawPath.startsWith("/api/jobs/") &&
    rawPath.endsWith("/cancel")
  ) {
    const bodyText = await readCappedBody(req);
    state.log.push({
      method,
      path: rawPath,
      bodyText,
      hadAuth,
      idempotencyKey: null,
    });
    const status = script.cancelStatus ?? 200;
    if (status === 404) {
      return jsonResponse(404, { error: "no such route" });
    }
    return jsonResponse(status, { cancelled: status === 200 });
  }
  return jsonResponse(404, { error: "not found" });
}

/**
 * Build a playback endpoint serving `tables`. Every table is
 * validated at construction by the workerd-safe mirrors above
 * (identical strictness to L4's validators); any invalid table
 * throws `PlaybackScriptError` fail-fast. State is fresh per call
 * and isolated per seed.
 */
export function createPlaybackHandler(
  tables: readonly PlaybackScenarioTable[],
): PlaybackHandler {
  const seeds = new Map<string, SeedState>();
  const prompts: string[] = [];
  for (const table of tables) {
    const { key, state } = checkSeedTable(table);
    if (seeds.has(key)) {
      throw new PlaybackScriptError(
        `duplicate scenario table ${JSON.stringify(key)}.`,
      );
    }
    seeds.set(key, state);
  }

  const fetch = async (req: Request): Promise<Response> => {
    const hostname = new URL(req.url).hostname;
    const seed = routeSeed(hostname);
    if (seed === null) {
      return jsonResponse(500, {
        error: `playback: unknown host ${JSON.stringify(hostname)}`,
      });
    }
    const state = seeds.get(seed);
    if (state === undefined) {
      return jsonResponse(500, {
        error: `playback: unknown seed ${JSON.stringify(seed)}`,
      });
    }
    try {
      const url = new URL(req.url);
      const rawPath = url.pathname;
      if (req.method === "GET" && rawPath === "/__playback/log") {
        return jsonResponse(200, state.log);
      }
      switch (state.provider) {
        case "mail":
          return await serveMail(state, req, rawPath);
        case "models":
          return await serveModels(state, req, rawPath);
        case "judgments":
          return await serveJudgments(state, req, rawPath);
        case "media":
          return await serveMedia(state, prompts, req, url, rawPath);
        default: {
          const unreachable: never = state;
          throw new Error(`playback: unreachable provider ${String(unreachable)}`);
        }
      }
    } catch {
      // Mirrors the harness server wrapper: any serving failure (bad
      // body, oversized body, malformed path encoding) is a 500.
      return jsonResponse(500, { error: "harness failure" });
    }
  };

  return {
    fetch,
    log: (seed: string): readonly PlaybackLogEntry[] => {
      const ref = parseSeedRef(seed);
      const state = seeds.get(`${ref.provider}:${ref.scenario}`);
      if (state === undefined) {
        throw new Error(`playback: unknown seed ${JSON.stringify(seed)}`);
      }
      return state.log;
    },
    mediaPrompts: (): readonly string[] => prompts,
  };
}


