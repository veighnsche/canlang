/**
 * Generation MCP host (BGI-05): the bounded in-process session behind
 * the `generation_context` / `generation_submit` tools.
 *
 * The session serves the captured attempt's immutable context and its
 * server-issued allowed output targets, validates every submission
 * batch through BGI-03's released `validateSubmissionBatch`, and
 * writes accepted candidates plus metadata to host-controlled
 * locations only. It never accepts caller paths, never touches
 * current saved files, and never promotes: completion of the
 * required output set is reported independently of the runner's exit,
 * and validation/acceptance stay separate BGI-11/12 phases.
 *
 * This object is the tool implementation the production stdio
 * transport calls (see `toolHandlers` and `serveMcpBridgeStdio`):
 * adapters attach the bridge command from `defaultMcpBridge()`,
 * and the bridge serves the attempt's live session over
 * newline-delimited JSON-RPC. Per-adapter capability qualification
 * stays with the frozen protocol table, not this file.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpBridge } from "./adapters.js";
import {
  MCP_CONTEXT_TOOL,
  MCP_SUBMIT_TOOL,
  McpError,
  handleGrammarValid,
  validateSubmissionBatch,
  type AllowedTarget,
  type GenerationContext,
  type SubmissionEntry,
} from "./protocol.js";

/** Per-handle submission metadata filename inside the candidate root. */
export const SUBMISSION_FILE = "submission.json";

/** Options for one host-bound MCP session over a captured attempt. */
export interface McpSessionOptions {
  /** Host-bound MCP session id (opaque, non-empty). */
  session: string;
  /** Captured attempt id (opaque, non-empty). */
  attempt: string;
  /** Digest of the captured source/contract closure. */
  source_digest: string;
  /** Server-issued allowed output targets for this session. */
  allowed: AllowedTarget[];
  /** Frozen source/contract/theme context supplied by the owning host. */
  instructions?: string;
  /** Host-owned candidate root; the only writable location. */
  candidateRoot: string;
  /**
   * Required handles for completion (defaults to every allowed
   * handle). Every entry must be an issued handle.
   */
  required?: readonly string[];
  /** Clock for `submitted_at` stamps (tests inject a fixed clock). */
  now?: () => number;
}

/** One host-written candidate plus its provenance metadata. */
export interface AcceptedCandidate {
  /** Issued handle that was submitted. */
  handle: string;
  /** Role admitted for the handle. */
  role: string;
  /** Server-chosen logical filename. */
  filename: string;
  /** Host-resolved candidate file path (never caller-chosen). */
  candidate: string;
  /** Accepted payload bytes. */
  bytes: number;
  /** SHA-256 hex of the accepted payload. */
  sha256: string;
}

/** Report for one accepted `generation_submit` batch. */
export interface SubmitReport {
  /** Accepted entries in batch order. */
  accepted: AcceptedCandidate[];
  /** True once every required handle has a submission. */
  complete: boolean;
  /** Required handles still missing a submission. */
  remaining: string[];
}

/** Required-output completion for the captured attempt. */
export interface SessionCompletion {
  /** True once every required handle has a submission. */
  complete: boolean;
  /** Handles with a recorded submission, in submission order. */
  submitted: string[];
  /** Required handles for this session. */
  required: string[];
  /** Required handles still missing a submission. */
  remaining: string[];
}

/** Session liveness: open work, an explicit cancel, or a fence move. */
export type McpSessionState = "open" | "cancelled" | "superseded";

/**
 * One bounded MCP session. Creation validates issuance (unique
 * grammar-valid handles, path-free server filenames) and picks up
 * submissions an earlier bounded try already wrote to the same
 * candidate root, so retries of one attempt share completion and
 * resubmission of a recorded handle always refuses.
 */
export interface McpSession {
  /** Host-bound MCP session id. */
  readonly id: string;
  /** Captured attempt id. */
  readonly attempt: string;
  /** Host-owned candidate root. */
  readonly candidateRoot: string;
  /** Current liveness. */
  readonly state: McpSessionState;
  /** Serve `generation_context`: immutable context, no paths/secrets. */
  context(): GenerationContext;
  /** Serve `generation_submit`: validate and host-write one batch. */
  submit(session: string, batch: SubmissionEntry[]): Promise<SubmitReport>;
  /** Required-output completion, independent of any runner exit. */
  completion(): SessionCompletion;
  /** Refuse all later submissions as cancelled (explicit cancel). */
  cancel(reason: string): void;
  /** Refuse all later submissions as superseded (reset/new fence). */
  supersede(reason: string): void;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function filenameSafe(filename: string): boolean {
  if (filename.length === 0 || filename.length > 128) return false;
  if (filename === "." || filename === "..") return false;
  return !filename.includes("/") && !filename.includes("\\") && !filename.includes("..");
}

function checkIssuance(options: McpSessionOptions): string[] {
  if (options.session.length === 0) {
    throw new McpError("invalid-session", "MCP sessions need a non-empty session id");
  }
  if (options.attempt.length === 0) {
    throw new McpError("invalid-session", "MCP sessions need a non-empty attempt id");
  }
  if (options.source_digest.length === 0) {
    throw new McpError("invalid-session", "MCP sessions need a non-empty source digest");
  }
  if (options.allowed.length === 0) {
    throw new McpError("invalid-session", "MCP sessions need at least one allowed output target");
  }
  const seen = new Set<string>();
  for (const target of options.allowed) {
    if (!handleGrammarValid(target.handle)) {
      throw new McpError(
        "invalid-session",
        `issued handle ${JSON.stringify(target.handle)} violates the opaque handle grammar`,
      );
    }
    if (seen.has(target.handle)) {
      throw new McpError(
        "invalid-session",
        `issued handle ${JSON.stringify(target.handle)} repeats; issuance is unique`,
      );
    }
    seen.add(target.handle);
    if (!filenameSafe(target.filename)) {
      throw new McpError(
        "invalid-session",
        `issued filename ${JSON.stringify(target.filename)} for handle ${JSON.stringify(target.handle)} is not a bare server-chosen name`,
      );
    }
  }
  const required = options.required ?? options.allowed.map((target) => target.handle);
  for (const handle of required) {
    if (!seen.has(handle)) {
      throw new McpError(
        "invalid-session",
        `required handle ${JSON.stringify(handle)} is not an issued handle for this session`,
      );
    }
  }
  return [...required];
}

interface StoredSubmission {
  handle: string;
  role: string;
  filename: string;
  bytes: number;
  sha256: string;
  session: string;
  attempt: string;
  submitted_at: string;
}

function isStoredSubmission(value: unknown): value is StoredSubmission {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["handle"] === "string" &&
    typeof record["role"] === "string" &&
    typeof record["filename"] === "string" &&
    typeof record["bytes"] === "number" &&
    typeof record["sha256"] === "string" &&
    typeof record["session"] === "string" &&
    typeof record["attempt"] === "string" &&
    typeof record["submitted_at"] === "string"
  );
}

/**
 * Pick up submissions an earlier bounded try of the same attempt
 * already wrote. Only well-formed host metadata for issued handles
 * counts; anything else is ignored, never collected as output.
 */
async function scanPriorSubmissions(
  candidateRoot: string,
  allowed: AllowedTarget[],
): Promise<Map<string, StoredSubmission>> {
  const found = new Map<string, StoredSubmission>();
  const issued = new Map(allowed.map((target) => [target.handle, target]));
  let entries: string[];
  try {
    entries = await readdir(candidateRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return found;
    throw error;
  }
  for (const entry of entries) {
    const target = issued.get(entry);
    if (target === undefined) continue;
    let text: string;
    try {
      text = await readFile(join(candidateRoot, entry, SUBMISSION_FILE), "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isStoredSubmission(parsed)) continue;
    if (parsed.handle !== entry || parsed.role !== target.role || parsed.filename !== target.filename) {
      continue;
    }
    found.set(entry, parsed);
  }
  return found;
}

/** One recorded candidate submission read back from disk. */
export interface CandidateSubmission {
  /** Issued handle that was submitted. */
  handle: string;
  /** Role admitted for the handle. */
  role: string;
  /** Server-chosen logical filename. */
  filename: string;
  /** Accepted payload bytes. */
  bytes: number;
  /** SHA-256 hex of the accepted payload. */
  sha256: string;
  /** Host-bound MCP session id that recorded it. */
  session: string;
  /** Captured attempt id that recorded it. */
  attempt: string;
  /** Submission stamp. */
  submitted_at: string;
  /** Host-resolved candidate file path. */
  candidate: string;
}

/**
 * Read every well-formed recorded submission under a candidate
 * root, in handle order. Only host metadata counts: a directory
 * whose name is not its stored handle, or whose metadata is
 * malformed, is ignored, never collected as output. BGI-12
 * status/diff/preview/accept inventory flows through this reader;
 * the live session remains the only writer.
 */
export async function readCandidateInventory(candidateRoot: string): Promise<CandidateSubmission[]> {
  let entries: string[];
  try {
    entries = await readdir(candidateRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const found: CandidateSubmission[] = [];
  for (const entry of entries.sort()) {
    if (!handleGrammarValid(entry)) continue;
    let text: string;
    try {
      text = await readFile(join(candidateRoot, entry, SUBMISSION_FILE), "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isStoredSubmission(parsed)) continue;
    if (parsed.handle !== entry) continue;
    // Foreign metadata never escapes the handle dir: only bare
    // server-chosen names resolve to a candidate path.
    if (!filenameSafe(parsed.filename)) continue;
    found.push({ ...parsed, candidate: join(candidateRoot, entry, parsed.filename) });
  }
  return found;
}

/**
 * Create one host-bound MCP session. The candidate root is created
 * when missing; current saved files are never consulted or written.
 */
export async function createMcpSession(options: McpSessionOptions): Promise<McpSession> {
  const required = checkIssuance(options);
  const now = options.now ?? Date.now;
  await mkdir(options.candidateRoot, { recursive: true });
  const prior = await scanPriorSubmissions(options.candidateRoot, options.allowed);
  const submitted = new Map<string, StoredSubmission>(prior);
  const order: string[] = [...prior.keys()];
  let state: McpSessionState = "open";
  let fenceNote = "";

  const contextShape = (): GenerationContext => ({
    session: options.session,
    attempt: options.attempt,
    source_digest: options.source_digest,
    allowed: options.allowed.map((target) => ({ ...target })),
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
  });

  const completionShape = (): SessionCompletion => {
    const remaining = required.filter((handle) => !submitted.has(handle));
    return {
      complete: remaining.length === 0,
      submitted: [...order],
      required: [...required],
      remaining,
    };
  };

  return {
    id: options.session,
    attempt: options.attempt,
    candidateRoot: options.candidateRoot,
    get state(): McpSessionState {
      return state;
    },
    context(): GenerationContext {
      return contextShape();
    },
    completion(): SessionCompletion {
      return completionShape();
    },
    cancel(reason: string): void {
      if (state === "open") {
        state = "cancelled";
        fenceNote = reason;
      }
    },
    supersede(reason: string): void {
      if (state === "open") {
        state = "superseded";
        fenceNote = reason;
      }
    },
    async submit(session: string, batch: SubmissionEntry[]): Promise<SubmitReport> {
      if (state === "cancelled") {
        throw new McpError(
          "session-cancelled",
          `session ${JSON.stringify(options.session)} was cancelled (${fenceNote}); late submissions refuse`,
        );
      }
      if (state === "superseded") {
        throw new McpError(
          "session-superseded",
          `session ${JSON.stringify(options.session)} was superseded (${fenceNote}); late submissions refuse`,
        );
      }
      const matched = validateSubmissionBatch(contextShape(), session, batch);
      for (const entry of batch) {
        if (submitted.has(entry.target)) {
          throw new McpError(
            "conflicting-submission",
            `submission target ${JSON.stringify(entry.target)} already has a recorded submission; duplicates refuse`,
          );
        }
      }
      const accepted: AcceptedCandidate[] = [];
      for (let index = 0; index < batch.length; index += 1) {
        const entry = batch[index] as SubmissionEntry;
        const target = matched[index] as AllowedTarget;
        const payload: Buffer =
          entry.content_text !== undefined
            ? Buffer.from(entry.content_text, "utf8")
            : Buffer.from(entry.content_base64 as string, "base64");
        const dir = join(options.candidateRoot, target.handle);
        await mkdir(dir, { recursive: true });
        const candidate = join(dir, target.filename);
        await writeFile(candidate, payload);
        const stored: StoredSubmission = {
          handle: target.handle,
          role: target.role,
          filename: target.filename,
          bytes: payload.length,
          sha256: sha256Hex(payload),
          session: options.session,
          attempt: options.attempt,
          submitted_at: new Date(now()).toISOString(),
        };
        await writeFile(join(dir, SUBMISSION_FILE), `${JSON.stringify(stored, null, 2)}\n`);
        submitted.set(target.handle, stored);
        order.push(target.handle);
        accepted.push({
          handle: target.handle,
          role: target.role,
          filename: target.filename,
          candidate,
          bytes: payload.length,
          sha256: stored.sha256,
        });
      }
      const completion = completionShape();
      return { accepted, complete: completion.complete, remaining: completion.remaining };
    },
  };
}

/** Parameters admitted by the `generation_submit` tool entry point. */
export interface SubmitToolParams {
  session: string;
  batch: SubmissionEntry[];
}

/**
 * The two frozen tool entry points over one session, keyed by the
 * BGI-03 tool names. The qualified wire transport calls these; the
 * submit entry validates its envelope before reaching the session.
 */
export function toolHandlers(session: McpSession): {
  [MCP_CONTEXT_TOOL]: () => GenerationContext;
  [MCP_SUBMIT_TOOL]: (params: SubmitToolParams) => Promise<SubmitReport>;
} {
  return {
    [MCP_CONTEXT_TOOL]: () => session.context(),
    [MCP_SUBMIT_TOOL]: async (params: SubmitToolParams) => {
      if (typeof params !== "object" || params === null) {
        throw new McpError("malformed-content", "generation_submit needs a {session, batch} envelope");
      }
      if (typeof params.session !== "string") {
        throw new McpError("malformed-content", "generation_submit needs a string session id");
      }
      if (!Array.isArray(params.batch)) {
        throw new McpError("malformed-content", "generation_submit needs a batch array");
      }
      return session.submit(params.session, params.batch);
    },
  };
}

/**
 * Production stdio transport over the live session. Adapters spawn
 * the bridge command from `defaultMcpBridge()` with the session
 * binding path in the environment; the bridge serves the frozen
 * `generation_context` / `generation_submit` tools over
 * newline-delimited JSON-RPC, one message per line. Bounded: a
 * per-line byte cap, a per-process request budget, and a protocol
 * error budget after which the bridge exits instead of serving
 * garbage. Submissions validate through the live session, so the
 * host still writes candidates and placement stays final; stdout
 * carries protocol bytes only, diagnostics go to stderr.
 */

/** Env var carrying the host-written session binding path (mirrors the adapter contract). */
const BRIDGE_SESSION_FILE_ENV = "CAN_GENERATION_SESSION_FILE";
/** Capture record filename inside an attempt dir (mirrors the control-layer layout). */
const BRIDGE_CAPTURE_FILE = "capture.json";
/** Candidate root inside an attempt dir (mirrors the control-layer layout). */
const BRIDGE_CANDIDATES_DIR = "candidates";
/** Attempt fence filename inside an attempt dir (mirrors the lifecycle layout). */
const BRIDGE_FENCE_FILE = "fence.json";

/** Maximum JSON-RPC bytes per stdio line (longer lines refuse without parsing). */
export const BRIDGE_MAX_LINE_BYTES = 1048576;
/** Maximum requests served per bridge process (bounded run lifetime). */
export const BRIDGE_MAX_REQUESTS = 4096;
/** Maximum protocol errors before the bridge exits fail-closed. */
export const BRIDGE_MAX_PROTOCOL_ERRORS = 32;
/** MCP protocol version served when the client offers none. */
export const BRIDGE_PROTOCOL_VERSION = "2025-06-18";
/** Bridge server name reported in `initialize`. */
export const BRIDGE_SERVER_NAME = "can-generation";
/** CLI flag selecting bridge mode when this module is the entry point. */
export const BRIDGE_ARGV_FLAG = "--bridge";

/** Roles the bridge admits from a capture handle map. */
const BRIDGE_ROLES: ReadonlySet<string> = new Set(["server", "browser", "style", "asset", "contributions"]);

/**
 * The production MCP stdio bridge command: this module as a Node
 * entry point in bridge mode. Adapters attach it; it reads its
 * session binding from the environment. Production callers use the
 * built module; the path always names the running file.
 */
export function defaultMcpBridge(): McpBridge {
  return { command: process.execPath, args: [fileURLToPath(import.meta.url), BRIDGE_ARGV_FLAG] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read one attempt fence generation (missing files are generation 0). */
async function readBridgeFence(attemptDir: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(join(attemptDir, BRIDGE_FENCE_FILE), "utf8")) as {
      generation?: unknown;
    };
    return typeof parsed.generation === "number" ? parsed.generation : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    throw error;
  }
}

/** One file-backed session opened from a host-written binding. */
export interface BoundBridgeSession {
  /** Live session over the attempt's candidate root. */
  session: McpSession;
  /** Host-owned attempt dir holding the binding, capture, and candidates. */
  attemptDir: string;
  /** Attempt fence generation the binding was issued at. */
  fence: number;
}

/**
 * Open the live session a bridge serves: the host-written binding
 * supplies session identity, the attempt capture supplies the
 * issued handles, and the candidate root receives submissions. A
 * moved fence, a missing capture, or malformed issuance refuses
 * before serving; the bridge never invents targets.
 */
async function readSessionBinding(sessionFile: string): Promise<{ session: string; attempt: string; source_digest: string; fence: number }> {
  if (sessionFile.length === 0) {
    throw new McpError(
      "invalid-session",
      `the MCP bridge needs a session binding path in ${BRIDGE_SESSION_FILE_ENV}`,
    );
  }
  let bindingRaw: unknown;
  try {
    bindingRaw = JSON.parse(await readFile(sessionFile, "utf8")) as unknown;
  } catch {
    throw new McpError(
      "invalid-session",
      `session binding at ${JSON.stringify(sessionFile)} does not open or parse`,
    );
  }
  if (!isRecord(bindingRaw)) {
    throw new McpError("invalid-session", "the session binding is not an object");
  }
  const session = bindingRaw["session"];
  const attempt = bindingRaw["attempt"];
  const source_digest = bindingRaw["source_digest"];
  const fence = bindingRaw["fence"];
  if (
    typeof session !== "string" ||
    session.length === 0 ||
    typeof attempt !== "string" ||
    attempt.length === 0 ||
    typeof source_digest !== "string" ||
    source_digest.length === 0 ||
    typeof fence !== "number"
  ) {
    throw new McpError("invalid-session", "the session binding carries no usable session/attempt/digest/fence");
  }
  return { session, attempt, source_digest, fence };
}

async function readBridgeCapture(attemptDir: string): Promise<Record<string, unknown>> {
  let captureRaw: unknown;
  try {
    captureRaw = JSON.parse(await readFile(join(attemptDir, BRIDGE_CAPTURE_FILE), "utf8")) as unknown;
  } catch {
    throw new McpError(
      "invalid-session",
      `attempt at ${JSON.stringify(attemptDir)} carries no readable capture`,
    );
  }
  if (!isRecord(captureRaw) || !Array.isArray(captureRaw["units"]) || !isRecord(captureRaw["handles"])) {
    throw new McpError("invalid-session", "the attempt capture carries no units/handles map");
  }
  return captureRaw;
}

function bridgeUnitKinds(captureRaw: Record<string, unknown>): Map<string, string> {
  const kinds = new Map<string, string>();
  for (const unit of captureRaw["units"] as unknown[]) {
    if (!isRecord(unit) || typeof unit["unit_id"] !== "string" || typeof unit["kind"] !== "string") {
      throw new McpError("invalid-session", "the attempt capture carries a malformed unit");
    }
    kinds.set(unit["unit_id"] as string, unit["kind"] as string);
  }
  return kinds;
}

function bridgeTargets(captureRaw: Record<string, unknown>, kinds: Map<string, string>): { allowed: AllowedTarget[]; required: string[] } {
  const allowed: AllowedTarget[] = [];
  const required: string[] = [];
  for (const [handle, issued] of Object.entries(captureRaw["handles"] as Record<string, unknown>)) {
    if (!isRecord(issued)) {
      throw new McpError("invalid-session", "the attempt capture carries a malformed handle map");
    }
    const unit = issued["unit"];
    const role = issued["role"];
    const filename = issued["filename"];
    if (
      typeof unit !== "string" ||
      typeof role !== "string" ||
      !BRIDGE_ROLES.has(role) ||
      typeof filename !== "string"
    ) {
      throw new McpError(
        "invalid-session",
        `issued handle ${JSON.stringify(handle)} carries no usable unit/role/filename`,
      );
    }
    const kind = kinds.get(unit);
    if (kind === undefined) {
      throw new McpError(
        "invalid-session",
        `issued handle ${JSON.stringify(handle)} names unknown unit ${JSON.stringify(unit)}`,
      );
    }
    allowed.push({ handle, role: role as AllowedTarget["role"], kind, filename });
    if (issued["required"] === true) required.push(handle);
  }
  return { allowed, required };
}

export async function openMcpSessionFromBinding(
  sessionFile: string,
  now?: () => number,
): Promise<BoundBridgeSession> {
  const { session, attempt, source_digest, fence } = await readSessionBinding(sessionFile);
  const attemptDir = dirname(sessionFile);
  const liveFence = await readBridgeFence(attemptDir);
  if (liveFence !== fence) {
    throw new McpError(
      "session-superseded",
      `session ${JSON.stringify(session)} was fenced (${String(fence)} -> ${String(liveFence)}); the bridge refuses a superseded session`,
    );
  }
  const captureRaw = await readBridgeCapture(attemptDir);
  const { allowed, required } = bridgeTargets(captureRaw, bridgeUnitKinds(captureRaw));
  const opened = await createMcpSession({
    session,
    attempt,
    source_digest,
    allowed,
    ...(typeof captureRaw["instructions"] === "string" ? { instructions: captureRaw["instructions"] } : {}),
    candidateRoot: join(attemptDir, BRIDGE_CANDIDATES_DIR),
    required,
    ...(now === undefined ? {} : { now }),
  });
  return { session: opened, attemptDir, fence };
}

/** Line ends the bridge speaks (process stdio or test streams). */
export interface BridgeServerOptions {
  /** Live session served over the wire. */
  session: McpSession;
  /** Newline-delimited JSON-RPC request bytes. */
  input: NodeJS.ReadableStream;
  /** Newline-delimited JSON-RPC response bytes (protocol only). */
  output: NodeJS.WritableStream;
  /**
   * Liveness guard: false refuses `tools/call` as fenced. The
   * entry wires the attempt fence; tests inject fakes.
   */
  fenceGuard?: () => Promise<boolean>;
  /** Request budget override (tests shrink it; default serves a full run). */
  maxRequests?: number;
}

function contextToolSchema(): Record<string, unknown> {
  return {
    name: MCP_CONTEXT_TOOL,
    description: "Return the immutable generation context and server-issued allowed output handles.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}

function submitToolSchema(): Record<string, unknown> {
  return {
    name: MCP_SUBMIT_TOOL,
    description: "Submit generated outputs against the session-issued handles; the host writes candidates.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string" },
        batch: {
          type: "array",
          items: {
            type: "object",
            properties: {
              target: { type: "string" },
              role: { type: "string" },
              content_text: { type: "string" },
              content_base64: { type: "string" },
            },
            required: ["target", "role"],
            additionalProperties: false,
          },
        },
      },
      required: ["session", "batch"],
      additionalProperties: false,
    },
  };
}

/**
 * Serve one live session over newline-delimited JSON-RPC until EOF:
 * `initialize`, `tools/list`, and `tools/call` for the two frozen
 * tools. Reads are fence-free; every `tools/call` rechecks
 * liveness, and submission failures report `isError` results, never
 * promotions. Returns the process exit code (0 for a clean EOF).
 */
export async function serveMcpBridgeStdio(options: BridgeServerOptions): Promise<number> {
  const tools = toolHandlers(options.session);
  const maxRequests = options.maxRequests ?? BRIDGE_MAX_REQUESTS;
  let requests = 0;
  let protocolErrors = 0;
  let buffer = "";
  const write = (value: unknown): void => {
    options.output.write(`${JSON.stringify(value)}\n`);
  };
  const fail = (id: unknown, code: number, message: string): void => {
    write({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  };
  const noteProtocolError = (id: unknown, code: number, message: string): boolean => {
    protocolErrors += 1;
    fail(id, code, message);
    return protocolErrors < BRIDGE_MAX_PROTOCOL_ERRORS;
  };
  const guardFence = async (method: string, id: unknown): Promise<boolean> => {
    if (method !== "tools/call" || options.fenceGuard === undefined) return true;
    let live = false;
    try {
      live = await options.fenceGuard();
    } catch {
      live = false;
    }
    if (live) return true;
    fail(id, -32000, "the attempt fence moved; late calls cannot submit");
    return false;
  };
  const callBridgeTool = async (id: unknown, params: unknown): Promise<void> => {
    if (!isRecord(params) || typeof params["name"] !== "string") {
      fail(id, -32602, "tools/call needs a {name, arguments} envelope");
      return;
    }
    const name = params["name"] as string;
    const args = isRecord(params["arguments"]) ? params["arguments"] : {};
    if (name === MCP_CONTEXT_TOOL) {
      const context = tools[MCP_CONTEXT_TOOL]();
      write({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(context) }] },
      });
    } else if (name === MCP_SUBMIT_TOOL) {
      try {
        const report = await tools[MCP_SUBMIT_TOOL](args as unknown as SubmitToolParams);
        write({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(report) }] },
        });
      } catch (error) {
        if (error instanceof McpError) {
          write({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ code: error.code, message: error.detail }) }],
              isError: true,
            },
          });
        } else {
          throw error;
        }
      }
    } else {
      fail(
        id,
        -32602,
        `unknown tool ${JSON.stringify(name)}; the bridge serves generation_context and generation_submit only`,
      );
    }
  };
  const dispatchMethod = async (method: string, id: unknown, message: Record<string, unknown>): Promise<void> => {
    try {
      if (method === "initialize") {
        const params = isRecord(message["params"]) ? (message["params"] as Record<string, unknown>) : {};
        const offered = params["protocolVersion"];
        write({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion:
              typeof offered === "string" && offered.length > 0 ? offered : BRIDGE_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: BRIDGE_SERVER_NAME, version: "1" },
          },
        });
      } else if (method === "ping") {
        write({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "tools/list") {
        write({ jsonrpc: "2.0", id, result: { tools: [contextToolSchema(), submitToolSchema()] } });
      } else if (method === "tools/call") {
        await callBridgeTool(id, message["params"]);
      } else {
        fail(id, -32601, `unknown method ${JSON.stringify(method)}`);
      }
    } catch (error) {
      fail(id, -32603, error instanceof Error ? error.message : String(error));
    }
  };
  const handleLine = async (line: string): Promise<boolean> => {
    if (line.trim().length === 0) return true;
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      return noteProtocolError(null, -32700, "the bridge accepts one JSON-RPC message per line");
    }
    if (!isRecord(message)) {
      return noteProtocolError(null, -32600, "the bridge accepts single JSON-RPC objects only");
    }
    const id = message["id"];
    const hasId = typeof id === "string" || typeof id === "number";
    const method = message["method"];
    if (typeof method !== "string") {
      // Notifications and response-ish noise without a method get
      // no response; malformed requests fail loudly.
      if (!hasId) return true;
      return noteProtocolError(id, -32600, "JSON-RPC requests need a string method");
    }
    if (!hasId) return true;
    requests += 1;
    if (requests > maxRequests) {
      fail(id, -32000, "the bridge served its bounded request budget for this run");
      return false;
    }
    if (!(await guardFence(method, id))) return true;
    await dispatchMethod(method, id, message);
    return true;
  };
  for await (const chunk of options.input) {
    buffer += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > BRIDGE_MAX_LINE_BYTES) {
        if (!noteProtocolError(null, -32700, "a stdio line exceeded the bounded message size")) return 1;
      } else if (!(await handleLine(line))) {
        return 1;
      }
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > BRIDGE_MAX_LINE_BYTES && Buffer.byteLength(buffer, "utf8") > BRIDGE_MAX_LINE_BYTES) {
      if (!noteProtocolError(null, -32700, "a stdio line exceeded the bounded message size")) return 1;
      buffer = "";
    }
  }
  if (buffer.trim().length > 0) {
    if (Buffer.byteLength(buffer, "utf8") > BRIDGE_MAX_LINE_BYTES) {
      noteProtocolError(null, -32700, "a stdio line exceeded the bounded message size");
      return protocolErrors >= BRIDGE_MAX_PROTOCOL_ERRORS ? 1 : 0;
    }
    if (!(await handleLine(buffer))) return 1;
  }
  return protocolErrors >= BRIDGE_MAX_PROTOCOL_ERRORS ? 1 : 0;
}

/** Bridge process entry: open the bound session and serve stdio until EOF. */
export async function runMcpBridgeFromEnv(): Promise<number> {
  const sessionFile = process.env[BRIDGE_SESSION_FILE_ENV] ?? "";
  try {
    const bound = await openMcpSessionFromBinding(sessionFile);
    return await serveMcpBridgeStdio({
      session: bound.session,
      input: process.stdin,
      output: process.stdout,
      fenceGuard: async () => (await readBridgeFence(bound.attemptDir)) === bound.fence,
    });
  } catch (error) {
    process.stderr.write(
      `can-generation MCP bridge: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

/** True only when this module is the entry point in bridge mode (library imports never fire). */
function invokedAsBridgeMain(): boolean {
  if (!process.argv.includes(BRIDGE_ARGV_FLAG)) return false;
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return resolve(script) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedAsBridgeMain()) {
  const code = await runMcpBridgeFromEnv();
  process.exit(code);
}
