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
 * This object is the tool implementation the future qualified wire
 * transport calls (see `toolHandlers`); the per-adapter stdio bridge
 * that attaches a live CLI is the held external gate, not this file.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
