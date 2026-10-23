/**
 * Generation controls (BGI-12): the one coordinated control layer
 * over the accepted producer mechanisms.
 *
 * This dispatcher serves every v1 operation except `doctor` (which
 * stays with the BGI-03 provider check in `cli/gen.ts`): compiler
 * inspection and validation delegate to the `can` binary through one
 * injectable bridge (`status`, `inspect`, `bind`, `validate`);
 * execution composes BGI-05 (`generate`, `refine`, `retry`, `resume`,
 * `cancel`, `reset` plus candidate `diff`/`preview` inventory); and
 * promotion composes BGI-04 journals/leases with BGI-11 validation
 * (`accept`, `adopt`, `rollback`, `edit.begin`/`edit.end`,
 * `lease.recover`).
 *
 * Join rules, kept in this file and nowhere else:
 * - Candidates validate as a complete set in a scratch overlay
 *   through the BGI-11 validator, compile/build/example/browser checks,
 *   then promote through one coordinated run journal. The role-to-saved filename map is
 *   the logical filename except role `server`, which lands at the
 *   intake primary `implementation.js` (the BGI-11 packer derives
 *   `server.js`/`view.js` from there at pack time).
 * - Capture binds new units through compiler `bind` (association
 *   evidence stays compiler-owned), snapshots current bytes plus
 *   source revisions, and fences every attempt. Acceptance compares
 *   the complete captured source/current/fence closure; conflicts
 *   preserve candidates and current files.
 * - A multi-unit attempt accepts only as a whole (attempt scope);
 *   unit scope serves single-unit attempts. `accept: true` composes
 *   the same validate/promote functions as the separate operations.
 * - Every execution request records its complete parent retry set
 *   in each job capture before any launch; manual and composed
 *   acceptance resolve that set and require all its outputs and
 *   checks through one journal, never a partial sibling.
 * - Keyword `declaration.json` is authored interface metadata (like
 *   source), checked by BGI-11 and reconciled by `adopt`; the
 *   control layer never derives producer/export claims.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AppAcceptanceError, runAppAcceptance, type AppAcceptanceGate } from "./acceptance.js";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  ConfigError,
  loadSettings,
  resolveRecipe,
  type EffectiveRecipe,
  type RecipeCategory,
  type RunOverrides,
} from "./config.js";
import {
  LifecycleError,
  withRequestLedger,
  persistRequestRecord,
  advanceFence,
  buildRetryJobs,
  cancelAttempt,
  executeJob,
  hashInput,
  readAttempt,
  readFence,
  resetAttempt,
  resumeSession,
  stableStringify,
  type ActiveClosure,
  type AttemptRecord,
  type CaptureUnit,
  type PlannedJob,
  type RequestOutcome,
  type RunRegistry,
} from "./lifecycle.js";
import { defaultMcpBridge, readCandidateInventory, type CandidateSubmission, type McpSession } from "./mcp.js";
import type { McpBridge } from "./adapters.js";
import {
  commitJournal,
  groupFiles,
  readJournal,
  recoverJournal,
  stageJournal,
  unresolvedJournals,
  JournalError,
  type Replacement,
} from "./journal.js";
import {
  LOCKS_DIR,
  acquire,
  parseToken,
  recoverStoppedWriter,
  release,
  validateRel,
  LeaseError,
} from "./leases.js";
import {
  GENERATED_DIR,
  UNIT_FILE,
  isUnitKind,
  parseUnitRecord,
  readSavedGroup,
  sha256HexBytes,
  sha256HexText,
  RecordError,
  type UnitKind,
  type UnitRecord,
} from "./records.js";
import {
  EXIT_CONFLICT,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_RUNNER,
  EXIT_UNKNOWN,
  EXIT_VALIDATION,
  PreflightError,
  ProtocolError,
  allowedOutputsFor,
  errorEnvelope,
  handleGrammarValid,
  okEnvelope,
  parseRequest,
  type AcceptParams,
  type AdoptParams,
  type AllowedTarget,
  type CancelParams,
  type DiffParams,
  type EditBeginParams,
  type EditEndParams,
  type GenerateParams,
  type GenParams,
  type LeaseRecoverParams,
  type McpRole,
  type McpUnitKind,
  type PreviewParams,
  type RefineParams,
  type RequestHeader,
  type ResetParams,
  type ResumeParams,
  type RetryParams,
  type RollbackParams,
  type StatusParams,
  type ValidatedRequest,
} from "./protocol.js";

/** Typed control failure with its process exit code. */
export class ControlError extends Error {
  /** Process exit code (0/2/3/4/5/6 per BGEN14). */
  readonly exit: number;
  /** Machine-readable code (`incomplete-set`, ...). */
  readonly code: string;
  /** Human-actionable detail without the code prefix. */
  readonly detail: string;
  /** Bounded next actions. */
  readonly next: string[];
  constructor(exit: number, code: string, detail: string, next: string[] = []) {
    super(`[${code}] ${detail}`);
    this.name = "ControlError";
    this.exit = exit;
    this.code = code;
    this.detail = detail;
    this.next = next;
  }
}

/** One finished control dispatch: exit code plus final envelope. */
export interface ControlResult {
  code: number;
  envelope: string;
}

/**
 * Compiler bridge: run one v1 JSON request through the `can` binary
 * and return its exit code plus raw stdout. Tests inject a fake;
 * production spawns the real binary (see `defaultCompilerCaller`).
 */
export type CompilerCaller = (requestJson: string) => Promise<{ code: number; stdout: string }>;

/** Git runner for `git:` rollback revisions (tests inject a fake). */
export type GitRunner = (
  args: readonly string[],
  options: { cwd: string },
) => Promise<{ code: number; stdout: string | Uint8Array; stderr: string }>;

/** Execution context for one control dispatch. */
export interface ControlContext {
  /** Compiler bridge (default: spawn the `can` binary). */
  compiler?: CompilerCaller;
  /** Refine `instruction_stdin` payload (read by the CLI join). */
  stdinText?: string;
  /** Clock for stamps (tests inject a fixed clock). */
  now?: () => number;
  /** Launch gate (default: BGI-03 preflight; overrides are test-only). */
  preflight?: (recipe: EffectiveRecipe) => void;
  /** Executable resolver (default: PATH probe; fakes inject a path). */
  resolveExecutable?: (binaries: readonly string[]) => Promise<string>;
  /** Registry receiving live runs' controllers for cancel(). */
  registry?: RunRegistry;
  /** Progress callback (the CLI join maps phases to JSONL events). */
  onEvent?: (phase: string, detail: string) => void;
  /**
   * Session hook: tests submit through the live MCP session here.
   * Production submissions arrive over the MCP bridge instead; the
   * hook stays a test fallback, never the qualification path.
   */
  onSession?: (session: McpSession) => void;
  /**
   * MCP stdio bridge attached to execution (default: the
   * production `defaultMcpBridge()` serving each attempt's live
   * session). Explicit null attaches no transport: the fake/test
   * path, where submissions arrive through `onSession` instead.
   */
  mcpBridge?: McpBridge | null;
  /** Codex home for the bounded per-attempt profile layer (default: the lifecycle production home). */
  codexHome?: string;
  /** Per-attempt profile name override (default: one name per attempt). */
  profileName?: string;
  /** Git runner (default: spawn `git -C root`). */
  git?: GitRunner;
  /** Mandatory candidate app checks; injection is for host tests only. */
  appAcceptance?: AppAcceptanceGate;
  /** Installed tooling workspace; source-file hosts need not run from it. */
  workspace?: string;
}

/** Job-scoped attempt dirs live directly under this root. */
export const ATTEMPTS_DIR = ".can/gen/attempts";
/** Per-unit attempt index: `<root>/<unit>/<attempt>.json`. */
export const UNIT_INDEX_DIR = ".can/gen/attempts/by-unit";
/** Transient scratch validation roots (removed after validation). */
export const VALIDATE_DIR = ".can/gen/validate";
/** Control request ledger: idempotency over mutating operations. */
export const CONTROLS_DIR = ".can/gen/controls";
/** Capture sentinel lease: serializes Node capture bind-new writes. */
export const CAPTURE_SENTINEL = "can.generated";
/** Capture record filename inside an attempt dir. */
export const CAPTURE_FILE = "capture.json";
/** Candidate root inside an attempt dir (BGI-05 layout). */
export const CANDIDATES_DIR = "candidates";
/** Discard/rescope record inside an attempt dir. */
export const DISCARDED_FILE = "discarded.json";
/** Snapshot dir inside an attempt dir (frozen capture evidence). */
export const SNAPSHOT_DIR = "snapshot";

/** Operations that read without mutating (no ledger entry). */
const READ_OPS: ReadonlySet<string> = new Set(["status", "inspect", "validate", "diff", "preview"]);

/** Default compiler binary: explicit env wins, else the checkout dev binary. */
export function defaultCompilerPath(): string {
  return process.env["CAN_COMPILER_BIN"] ?? join(process.cwd(), "compiler/target/debug/can");
}

/** Default bridge: pipe one request through `can gen` on stdin. */
export async function defaultCompilerCaller(requestJson: string): Promise<{
  code: number;
  stdout: string;
}> {
  const bin = defaultCompilerPath();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, ["gen"], {
      stdio: ["pipe", "pipe", "pipe"], shell: false,
      env: { ...process.env, CAN_GENERATION_COMPILER_ONLY: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (cause: unknown) => {
      rejectPromise(
        new Error(
          `cannot run the compiler at ${JSON.stringify(bin)}: ${cause instanceof Error ? cause.message : String(cause)} (set CAN_COMPILER_BIN)`,
        ),
      );
    });
    child.on("close", (code) => {
      if (stdout.length === 0) {
        rejectPromise(
          new Error(
            `the compiler at ${JSON.stringify(bin)} exited ${String(code ?? "unknown")} with no stdout${stderr.length > 0 ? `: ${stderr.slice(0, 400)}` : ""}`,
          ),
        );
        return;
      }
      resolvePromise({ code: code ?? 1, stdout });
    });
    try {
      child.stdin?.write(requestJson);
      child.stdin?.end();
    } catch (error) {
      rejectPromise(error);
    }
  });
}

/** Default git runner: `git -C root` with captured output. */
async function defaultGitRunner(
  args: readonly string[],
  options: { cwd: string },
): Promise<{ code: number; stdout: Uint8Array; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["-C", options.cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (cause: unknown) => {
      rejectPromise(cause instanceof Error ? cause : new Error(String(cause)));
    });
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr });
    });
  });
}

/** Best-effort request id/operation echo for failed parses. */
function echoHeader(text: string): { request_id: string; operation: string } {
  try {
    const value: unknown = JSON.parse(text) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const map = value as Record<string, unknown>;
      return {
        request_id: typeof map["request_id"] === "string" ? (map["request_id"] as string) : "",
        operation: typeof map["operation"] === "string" ? (map["operation"] as string) : "unknown",
      };
    }
  } catch {
    // Fall through to the markers below.
  }
  return { request_id: "", operation: "unknown" };
}

/** One recorded control outcome (returned verbatim on resend). */
interface ControlRecord {
  request_id: string;
  input_hash: string;
  superseded: boolean;
  operation: string;
  code: number;
  state: string;
  envelope: string;
  claim?: string;
}

type ControlLookup =
  | { readonly status: "absent" }
  | { readonly status: "same"; readonly record: ControlRecord }
  | { readonly status: "superseded" }
  | { readonly status: "conflict" };

function controlLedgerFile(root: string, request_id: string): string {
  // Caller request ids are never path-interpolated raw.
  const safe = handleGrammarValid(request_id) ? request_id : `id-${hashInput(request_id)}`;
  return join(root, CONTROLS_DIR, `${safe}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isControlRecord(value: unknown): value is ControlRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value["request_id"] === "string" &&
    typeof value["input_hash"] === "string" &&
    typeof value["superseded"] === "boolean" &&
    typeof value["operation"] === "string" &&
    typeof value["code"] === "number" &&
    typeof value["state"] === "string" &&
    typeof value["envelope"] === "string"
  );
}

/** Look up one control request id against the recorded input hash. */
async function lookupControl(
  root: string,
  request_id: string,
  inputHash: string,
): Promise<ControlLookup> {
  let text: string;
  try {
    text = await readFile(controlLedgerFile(root, request_id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "absent" };
    throw error;
  }
  let record: unknown;
  try {
    record = JSON.parse(text) as unknown;
  } catch {
    throw new ControlError(
      EXIT_UNKNOWN,
      "ledger-unreadable",
      `request ${JSON.stringify(request_id)} has an unreadable control record; recover explicitly`,
      ["inspect the control ledger and resend with a new request id"],
    );
  }
  if (!isControlRecord(record) || record.request_id !== request_id) {
    throw new ControlError(
      EXIT_UNKNOWN,
      "ledger-unreadable",
      `request ${JSON.stringify(request_id)} has an unreadable control record; recover explicitly`,
      ["inspect the control ledger and resend with a new request id"],
    );
  }
  if (record.superseded) return { status: "superseded" };
  if (record.input_hash !== inputHash) return { status: "conflict" };
  return { status: "same", record };
}

/** Store one control outcome under its input hash. */
async function storeControl(
  root: string,
  request_id: string,
  inputHash: string,
  operation: string,
  code: number,
  state: string,
  envelope: string,
  claim: string,
): Promise<void> {
  const record: ControlRecord = {
    request_id,
    input_hash: inputHash,
    superseded: false,
    operation,
    code,
    state,
    envelope, claim,
  };
  const path = controlLedgerFile(root, request_id);
  await withRequestLedger(root, path, async () => {
    const current = JSON.parse(await readFile(path, "utf8")) as ControlRecord;
    if (current.superseded || current.claim !== claim || current.input_hash !== inputHash) {
      throw new ControlError(EXIT_CONFLICT, "request-superseded", "The control claim changed; its old execution cannot publish a new outcome.");
    }
    await persistRequestRecord(path, record);
  });
}

/**
 * Mark one control request id superseded (cancel/reset fenced its
 * attempt). A resend then starts fresh work instead of recovering;
 * late output from the fenced attempt still refuses.
 */
async function markControlSuperseded(root: string, request_id: string): Promise<void> {
  const path = controlLedgerFile(root, request_id);
  await withRequestLedger(root, path, async () => {
    let record: ControlRecord | null = null;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (isControlRecord(parsed) && parsed.request_id === request_id) record = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    if (record === null) {
      record = {
        request_id,
        input_hash: "",
        superseded: true,
        operation: "unknown",
        code: EXIT_OK,
        state: "superseded",
        envelope: "",
      };
    } else {
      record.superseded = true;
    }
    await persistRequestRecord(path, record);
  });
}

/** List every control ledger record, in request-id order. */
export async function listControlRecords(root: string): Promise<ControlRecord[]> {
  let names: string[];
  try {
    names = await readdir(join(root, CONTROLS_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const out: ControlRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(root, CONTROLS_DIR, name), "utf8"),
      ) as unknown;
      if (isControlRecord(parsed)) out.push(parsed);
    } catch {
      // Unreadable ledger files are reported by lookup on resend;
      // the status listing skips them rather than failing.
    }
  }
  out.sort((a, b) => (a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0));
  return out;
}

/** Extract the terminal state from a just-built envelope. */
function stateOf(envelope: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(envelope) as unknown;
    if (isRecord(parsed) && typeof parsed["state"] === "string") {
      return parsed["state"] as string;
    }
  } catch {
    // Fall through to the fallback below.
  }
  return fallback;
}

// Per-dispatch authority is private and copied so callers can reuse their context.
const controlClaims = new WeakMap<ControlContext, { root: string; request_id: string; token: string }>();

async function withControlClaim<T>(ctx: ControlContext, action: () => Promise<T>): Promise<T> {
  const claim = controlClaims.get(ctx);
  if (claim === undefined) return action();
  const path = controlLedgerFile(claim.root, claim.request_id);
  return withRequestLedger(claim.root, path, async () => {
    const current = JSON.parse(await readFile(path, "utf8")) as ControlRecord;
    if (current.superseded || current.claim !== claim.token) {
      throw new ControlError(EXIT_CONFLICT, "request-superseded", "Old control no longer owns this request; it cannot launch new work.");
    }
    return action();
  });
}

/**
 * Run one v1 control request: parse, ledger mutating operations for
 * idempotency, route to the operation handler, and record the
 * terminal outcome. Semantic failures become typed envelopes;
 * infrastructure failures (compiler spawn, corrupt JSON, IO
 * crashes) leave the durable pending outcome for explicit recovery.
 */

export async function dispatchControl(
  text: string,
  ctx: ControlContext = {},
): Promise<ControlResult> {
  let validated: ValidatedRequest;
  try {
    validated = parseRequest(text);
  } catch (error) {
    if (error instanceof ProtocolError) {
      const echo = echoHeader(text);
      return {
        code: error.exit,
        envelope: errorEnvelope(echo.request_id, echo.operation, error.code, error.detail, [
          "fix the request and resend (see can help gen)",
        ]),
      };
    }
    throw error;
  }
  const { header, params } = validated;
  if (params.kind === "doctor") {
    throw new ControlError(
      EXIT_INVALID,
      "wrong-dispatcher",
      "doctor is served by the provider check; route it there, not to the control layer",
      ["send doctor through the CLI provider check"],
    );
  }
  const root = rootOf(params);
  const inputHash = hashInput(
    stableStringify({ operation: header.operation, params: params.params }),
  );
  const ledgered = !READ_OPS.has(params.kind);
  let claim: string | undefined;
  try {
    if (ledgered) {
      const recorded = await lookupControl(root, header.request_id, inputHash);
      const admission = recorded.status === "same" || recorded.status === "conflict" ? recorded :
        await withRequestLedger(root, controlLedgerFile(root, header.request_id), async () => {
          const lookup = await lookupControl(root, header.request_id, inputHash);
          if (lookup.status === "same" || lookup.status === "conflict") return lookup;
          const token = randomUUID();
          const envelope = errorEnvelope(header.request_id, header.operation, "request-in-flight",
            "This request is durably bound; execution may be running or interrupted. Resending cannot launch new work.",
            ["inspect the recorded attempts; wait for completion or explicitly recover stopped work"]);
          await persistRequestRecord(controlLedgerFile(root, header.request_id), {
            request_id: header.request_id, input_hash: inputHash, superseded: false,
            operation: header.operation, code: EXIT_UNKNOWN, state: "unknown", envelope, claim: token,
          });
          return { status: "claimed" as const, token };
        });
      const lookup = admission;
      if (lookup.status === "same") {
        ctx.onEvent?.("recovered", `request ${JSON.stringify(header.request_id)} recovers its recorded outcome`);
        return { code: lookup.record.code, envelope: lookup.record.envelope };
      }
      if (lookup.status === "conflict") {
        return {
          code: EXIT_CONFLICT,
          envelope: errorEnvelope(
            header.request_id,
            header.operation,
            "request-conflict",
            `request ${JSON.stringify(header.request_id)} carries changed input; a new id is required for new work`,
            ["resend changed work under a new request id"],
          ),
        };
      }
      if (lookup.status === "claimed") claim = lookup.token;
    }
    ctx = { ...ctx };
    if (claim !== undefined) controlClaims.set(ctx, { root, request_id: header.request_id, token: claim });
    const result = await runOperation(header, params, ctx);
    if (ledgered) {
      await storeControl(
        root,
        header.request_id,
        inputHash,
        header.operation,
        result.code,
        stateOf(result.envelope, "unknown"),
        result.envelope,
        claim!,
      );
    }
    return result;
  } catch (error) {
    const mapped = mapFailure(error);
    if (mapped === null) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        code: claim === undefined ? EXIT_INVALID : EXIT_UNKNOWN,
        envelope: errorEnvelope(
          header.request_id,
          header.operation,
          claim === undefined ? "control-failed" : "request-outcome-unknown",
          detail,
          ["inspect the recorded attempt; resend the same request to recover without relaunching"],
        ),
      };
    }
    const envelope = errorEnvelope(
      header.request_id,
      header.operation,
      mapped.code,
      mapped.detail,
      mapped.next,
    );
    if (ledgered && claim !== undefined && mapped.code !== "request-superseded" && mapped.code !== "request-in-flight") {
      await storeControl(
        root,
        header.request_id,
        inputHash,
        header.operation,
        mapped.exit,
        "error",
        envelope,
        claim,
      );
    }
    return { code: mapped.exit, envelope };
  }
}

/** Map a producer failure to a control failure, or null when infrastructural. */
function mapFailure(error: unknown): ControlError | null {
  if (error instanceof ControlError) return error;
  if (error instanceof AppAcceptanceError) {
    return new ControlError(EXIT_VALIDATION, "app-acceptance-failed", error.message,
      ["inspect the app check report, repair the candidate or tests, then resend accept with a new request id"]);
  }
  if (error instanceof ProtocolError) {
    return new ControlError(error.exit, error.code, error.detail, [
      "fix the request and resend",
    ]);
  }
  // Lifecycle failures already carry their BGEN14 exit.
  if (error instanceof LifecycleError) {
    return new ControlError(error.exit, error.code, error.detail, [
      "inspect the attempt and resend corrected work with a new request id",
    ]);
  }
  if (error instanceof LeaseError) {
    const invalid = error.code === "invalid-id" || error.code === "invalid-token";
    return new ControlError(
      invalid ? EXIT_INVALID : EXIT_CONFLICT,
      error.code,
      error.message.replace(/^lease: /, ""),
      invalid
        ? ["fix the lease selector and resend"]
        : ["retry after the holder releases, or recover the lease once its writer has stopped"],
    );
  }
  if (error instanceof JournalError) {
    const invalid = error.code === "invalid-id" || error.code === "invalid-path";
    return new ControlError(
      invalid ? EXIT_INVALID : EXIT_CONFLICT,
      error.code,
      error.message.replace(/^generation-journal: /, ""),
      invalid
        ? ["fix the journal selector and resend"]
        : ["recover the run journal, then resend with a new request id"],
    );
  }
  if (error instanceof RecordError) {
    return new ControlError(EXIT_INVALID, error.code, error.message.replace(/^generation-record: /, ""), [
      "send a status request to list saved units, then bind or generate",
    ]);
  }
  if (error instanceof ConfigError) {
    return new ControlError(EXIT_INVALID, error.code, error.detail, [
      "fix the recipe selection and resend",
    ]);
  }
  if (error instanceof PreflightError) {
    return new ControlError(EXIT_INVALID, error.code, error.detail, [
      "resolve the launch gate and resend",
    ]);
  }
  return null;
}

/** Every control operation except doctor carries a required root. */
function rootOf(params: GenParams): string {
  switch (params.kind) {
    case "doctor":
      throw new ControlError(EXIT_INVALID, "wrong-dispatcher", "doctor has no control root");
    default:
      return params.params.root as string;
  }
}

/** One parsed compiler envelope: exit code plus JSON body. */
interface CompilerResult {
  code: number;
  body: Record<string, unknown>;
}

/**
 * Run one v1 request through the compiler bridge and parse its
 * envelope. Malformed output is infrastructural (unstored); a
 * well-formed error envelope is semantic and maps verbatim.
 */
async function compilerRequest(
  ctx: ControlContext,
  request: Record<string, unknown>,
): Promise<CompilerResult> {
  const caller = ctx.compiler ?? defaultCompilerCaller;
  const { code, stdout } = await caller(JSON.stringify(request));
  let body: unknown;
  try {
    body = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(
      `the compiler returned non-JSON output (exit ${String(code)}): ${stdout.slice(0, 200)}`,
    );
  }
  if (!isRecord(body) || typeof body["ok"] !== "boolean") {
    throw new Error(
      `the compiler returned a malformed envelope (exit ${String(code)}): ${stdout.slice(0, 200)}`,
    );
  }
  return { code, body };
}

/** A compiler error envelope mapped to a control failure. */
function compilerFailure(operation: string, result: CompilerResult): ControlError {
  const error = isRecord(result.body["error"])
    ? (result.body["error"] as Record<string, unknown>)
    : {};
  const code = typeof error["code"] === "string" ? (error["code"] as string) : "compiler-error";
  const message =
    typeof error["message"] === "string"
      ? (error["message"] as string)
      : `the compiler refused the ${operation} request`;
  const next = Array.isArray(result.body["next"])
    ? (result.body["next"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : ["fix the reported issue and resend"];
  const exit =
    result.code === EXIT_OK ||
    result.code === EXIT_INVALID ||
    result.code === EXIT_CONFLICT ||
    result.code === EXIT_VALIDATION ||
    result.code === EXIT_RUNNER ||
    result.code === EXIT_UNKNOWN
      ? result.code
      : EXIT_INVALID;
  return new ControlError(exit === EXIT_OK ? EXIT_INVALID : exit, code, message, next);
}

/** Fresh descriptor contract from the status seam (BGI-12 addition). */
export interface SeamContract {
  target: string | null;
  profile: string | null;
  prompt_sha256: string;
  signature: string | null;
}

/** One parsed status unit, including the BGI-12 capture seam. */
export interface StatusUnit {
  id: string | null;
  owner: string;
  kind: string;
  label: string | null;
  path: string | null;
  association: string;
  prompt: string | null;
  contract: SeamContract | null;
  span: { start: number; end: number } | null;
  prompt_changed: boolean | null;
  candidates: string[];
  action: string | null;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asOptionalUint(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseSeamContract(value: unknown): SeamContract | null {
  if (!isRecord(value)) return null;
  const prompt_sha256 = value["prompt_sha256"];
  if (typeof prompt_sha256 !== "string") return null;
  return {
    target: asOptionalString(value["target"]),
    profile: asOptionalString(value["profile"]),
    prompt_sha256,
    signature: asOptionalString(value["signature"]),
  };
}

function parseStatusUnit(value: unknown): StatusUnit | null {
  if (!isRecord(value)) return null;
  const association = value["association"];
  const kind = value["kind"];
  const owner = value["owner"];
  if (typeof association !== "string" || (kind !== undefined && typeof kind !== "string")) {
    return null;
  }
  let span: { start: number; end: number } | null = null;
  if (isRecord(value["span"])) {
    const record = value["span"] as Record<string, unknown>;
    const start = asOptionalUint(record["start"]);
    const end = asOptionalUint(record["end"]);
    if (start !== null && end !== null) span = { start, end };
  }
  const candidates = Array.isArray(value["candidates"])
    ? (value["candidates"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    id: asOptionalString(value["id"]),
    owner: typeof owner === "string" ? owner : "",
    kind: typeof kind === "string" ? kind : "?",
    label: asOptionalString(value["label"]),
    path: asOptionalString(value["path"]),
    association,
    prompt: asOptionalString(value["prompt"]),
    contract: parseSeamContract(value["contract"]),
    span,
    prompt_changed: typeof value["prompt_changed"] === "boolean" ? value["prompt_changed"] : null,
    candidates,
    action: asOptionalString(value["action"]),
  };
}

/** Run compiler `status` over scope files and parse its units. */
async function compilerStatus(
  ctx: ControlContext,
  request_id: string,
  root: string,
  files: string[],
): Promise<StatusUnit[]> {
  // The compiler resolves file operands against its own working
  // directory, not the request root: the bridge absolutizes.
  const result = await compilerRequest(ctx, {
    version: 1,
    request_id: `${request_id}.status`,
    operation: "status",
    root,
    files: files.map((file) => scopeAbs(root, file)),
  });
  if (result.code !== EXIT_OK || result.body["ok"] !== true) {
    throw compilerFailure("status", result);
  }
  const issues = result.body["issues"];
  if (issues !== undefined && !Array.isArray(issues)) {
    throw new Error("the compiler status report carries a malformed issues field");
  }
  if (Array.isArray(issues) && issues.length > 0) {
    const details = issues.slice(0, 16).map(issue => isRecord(issue) && typeof issue["detail"] === "string"
      ? `${typeof issue["unit"] === "string" ? issue["unit"] + ": " : ""}${issue["detail"]}`
      : "saved unit intake is unresolved");
    throw new ControlError(EXIT_INVALID, "unresolved-intake", `saved unit intake must be reconciled before allocation or generation:\n${details.join("\n")}`,
      ["repair the saved group or send an explicit bind request, then resend"]);
  }
  const units = result.body["units"];
  if (!Array.isArray(units)) {
    throw new Error("the compiler status report carries no units array");
  }
  return units.map((entry, index) => {
    const parsed = parseStatusUnit(entry);
    if (parsed === null) {
      throw new Error(`the compiler status report carries a malformed unit at index ${String(index)}`);
    }
    return parsed;
  });
}

/** Resolve the complete status before any allocation, launch or publication. */
function assertResolvableStatus(status: readonly StatusUnit[]): void {
  const claimed = new Set<string>();
  for (const entry of status) {
    if (entry.association === "orphaned") continue;
    if (entry.association === "ambiguous" || entry.association === "displaced") {
      const names = entry.candidates.length > 0 ? entry.candidates.join(",") : "(none)";
      throw new ControlError(EXIT_INVALID, "ambiguous-unit",
        `scope unit ${entry.owner}/${entry.kind}/${entry.label ?? "-"} has unresolved ownership (candidates: ${names}); reconcile with an explicit bind`,
        ["send a bind request to reconcile the unit, then resend"]);
    }
    if (entry.association !== "new" && entry.association !== "retained") {
      throw new Error(`the compiler reported an unknown association ${JSON.stringify(entry.association)}`);
    }
    if (entry.path === null || entry.prompt === null || entry.contract === null || entry.span === null || !isUnitKind(entry.kind)) {
      throw new ControlError(EXIT_INVALID, "missing-capture-seam", "the compiler status report carries no complete prompt/contract/location seam; rebuild the compiler and resend");
    }
    if (entry.association === "retained") {
      if (entry.id === null) throw new Error("the compiler reported a retained unit without an id");
      if (claimed.has(entry.id)) throw new ControlError(EXIT_INVALID, "ambiguous-unit",
        `saved unit ${JSON.stringify(entry.id)} is claimed by multiple defining slots; reconcile with an explicit bind`);
      claimed.add(entry.id);
    }
  }
}

async function preflightSavedBindings(ctx: ControlContext, header: RequestHeader, root: string, scope: readonly PromotionUnit[]): Promise<void> {
  const files = [...new Set(scope.flatMap(entry => entry.capture.files))];
  const status = await compilerStatus(ctx, header.request_id, root, files);
  assertResolvableStatus(status);
  for (const entry of scope) if (!status.some(unit => unit.id === entry.unit_id && unit.association === "retained")) {
    throw new ControlError(EXIT_INVALID, "stale-association",
      `saved unit ${JSON.stringify(entry.unit_id)} no longer matches its owning source; reconcile with an explicit bind`);
  }
}

/** Route one validated request to its operation handler. */
async function runOperation(
  header: RequestHeader,
  params: GenParams,
  ctx: ControlContext,
): Promise<ControlResult> {
  switch (params.kind) {
    case "doctor":
      throw new ControlError(EXIT_INVALID, "wrong-dispatcher", "doctor is served by the provider check");
    case "status":
      return runStatus(header, params.params, ctx);
    case "inspect":
      return runPassthrough(header, params.params, "inspect", ctx);
    case "bind":
      return runPassthrough(header, params.params, "bind", ctx);
    case "generate":
      return runGenerate(header, params.params, ctx);
    case "refine":
      return runRefine(header, params.params, ctx);
    case "retry":
      return runRetry(header, params.params, ctx);
    case "resume":
      return runResume(header, params.params, ctx);
    case "diff":
      return runDiff(header, params.params, ctx);
    case "preview":
      return runPreview(header, params.params, ctx);
    case "validate":
      return runPassthrough(header, params.params, "validate", ctx);
    case "adopt":
      return runAdopt(header, params.params, ctx);
    case "accept":
      return runAccept(header, params.params, ctx);
    case "cancel":
      return runCancel(header, params.params, ctx);
    case "reset":
      return runReset(header, params.params, ctx);
    case "rollback":
      return runRollback(header, params.params, ctx);
    case "edit.begin":
      return runEditBegin(header, params.params, ctx);
    case "edit.end":
      return runEditEnd(header, params.params, ctx);
    case "lease.recover":
      return runLeaseRecover(header, params.params, ctx);
  }
}

/**
 * Forward one request to the compiler and return its envelope
 * untouched. Source operands absolutize against the request root;
 * saved validation operands stay canonical root-relative paths.
 * Every other field passes through verbatim, and the control layer
 * adds no fields to the response.
 */
async function runPassthrough(
  header: RequestHeader,
  params: object,
  operation: string,
  ctx: ControlContext,
): Promise<ControlResult> {
  const caller = ctx.compiler ?? defaultCompilerCaller;
  const forwarded = compilerOperands(params, operation);
  const { code, stdout } = await caller(
    JSON.stringify({ version: 1, request_id: header.request_id, operation, ...forwarded }),
  );
  let body: unknown;
  try {
    body = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(
      `the compiler returned non-JSON output for ${operation} (exit ${String(code)}): ${stdout.slice(0, 200)}`,
    );
  }
  if (!isRecord(body) || typeof body["ok"] !== "boolean") {
    throw new Error(
      `the compiler returned a malformed envelope for ${operation} (exit ${String(code)}): ${stdout.slice(0, 200)}`,
    );
  }
  return { code, envelope: stdout.endsWith("\n") ? stdout : `${stdout}\n` };
}

/** Source operands resolve from the compiler cwd; saved validation uses root-relative paths. */
function compilerOperands(params: object, operation: string): Record<string, unknown> {
  const record = { ...(params as Record<string, unknown>) };
  const root = record["root"];
  if (typeof root !== "string") return record;
  const absolutize = (file: string): string => scopeAbs(root, file);
  if ((operation === "status" || operation === "validate") && Array.isArray(record["files"])) {
    record["files"] = (record["files"] as unknown[]).map(file => {
      if (typeof file !== "string") return file;
      return operation === "validate" ? leaseRel(root, file) ?? absolutize(file) : absolutize(file);
    });
  }
  if ((operation === "inspect" || operation === "bind") && typeof record["file"] === "string") {
    record["file"] = absolutize(record["file"] as string);
  }
  return record;
}

/**
 * `status`: the compiler report plus the produced-work overlay.
 * Compiler fields pass through untouched; `produced` exposes every
 * unit's candidates across attempts (no source names needed) and
 * `operations` lists recorded control outcomes.
 */
async function runStatus(
  header: RequestHeader,
  params: StatusParams,
  ctx: ControlContext,
): Promise<ControlResult> {
  const pass = await runPassthrough(header, params, "status", ctx);
  if (pass.code !== EXIT_OK) return pass;
  const body = JSON.parse(pass.envelope) as Record<string, unknown>;
  if (body["ok"] !== true) return pass;
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "version" || key === "request_id" || key === "operation" || key === "ok" || key === "state" || key === "next") {
      continue;
    }
    payload[key] = value;
  }
  payload["produced"] = await producedOverlay(params.root);
  payload["operations"] = await operationsOverlay(params.root);
  const next = Array.isArray(body["next"])
    ? (body["next"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    code: EXIT_OK,
    envelope: okEnvelope(header, typeof body["state"] === "string" ? body["state"] : "reported", payload, next),
  };
}

/** Build a final envelope with an explicit ok flag for aggregate states. */
function resultEnvelope(
  header: RequestHeader,
  ok: boolean,
  state: string,
  payload: Record<string, unknown>,
  next: string[],
): string {
  return `${JSON.stringify({
    version: 1,
    request_id: header.request_id,
    operation: header.operation,
    ok,
    state,
    ...payload,
    next,
  })}\n`;
}

/** Directory entries that cannot escape their parent when joined. */
function safeEntry(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Derive a filesystem-safe attempt id from a caller request id. */
export function attemptFor(request_id: string, order: number): string {
  const base = handleGrammarValid(request_id) ? request_id : `id-${hashInput(request_id).slice(0, 16)}`;
  return `${base}.j${String(order)}`;
}

/** Derive a filesystem-safe journal run id from a caller request id. */
export function runFor(prefix: string, request_id: string): string {
  const base = handleGrammarValid(request_id) ? request_id : `id-${hashInput(request_id).slice(0, 16)}`;
  return `${prefix}-${base}`;
}

/** Recipe category for one unit kind (Then kinds resolve frontend). */
function categoryFor(kind: UnitKind): RecipeCategory {
  switch (kind) {
    case "style":
    case "style-inline":
    case "view":
    case "view-style-inline":
      return "frontend";
    default:
      return "given";
  }
}

/** One issued handle inside a capture record. */
export interface CaptureHandle {
  unit: string;
  role: string;
  filename: string;
  /** Unit-relative saved path this handle promotes to. */
  saved: string;
  required: boolean;
}

/** One captured unit inside a capture record. */
export interface CaptureUnitState {
  unit_id: string;
  kind: string;
  category: RecipeCategory;
  agent: string | null;
  prompt: string;
  contract: SeamContract;
  prompt_changed: boolean;
  /** Current group bytes (rel -> sha256, including unit.json), or null when unborn. */
  current: Record<string, string> | null;
  span: { start: number; end: number } | null;
  job: number;
  /** Association key evidence for semantic record comparison. */
  owner: string;
  label: string | null;
  path: string;
  /** Live unit.json text at capture (association baseline). */
  record_json: string | null;
}

/**
 * The complete required parent retry set one execution request
 * planned: every job attempt plus every unit in the request scope.
 * Recorded in every job capture before any launch, so manual and
 * composed acceptance resolve the whole set and require all its
 * outputs and checks through one journal. Absent on older and
 * single-shot captures (resume, rollback), which accept alone.
 */
export interface ParentRetrySet {
  /** Parent execution request id that planned the set. */
  request_id: string;
  /** Every job attempt in the set, in launch order. */
  attempts: string[];
  /** Every unit in the set, sorted. */
  units: string[];
}

/** The frozen capture behind one job attempt. */
export interface CaptureRecord {
  version: 1;
  attempt: string;
  request_id: string;
  operation: string;
  mode: string;
  root: string;
  files: string[];
  app_id: string;
  source_digest: string;
  captured_at: string;
  /** Attempt fence generation at capture (accept compares). */
  fence: number;
  source_revisions: Record<string, string>;
  units: CaptureUnitState[];
  /** Reused saved dependency states; never generation assignments or promotion targets. */
  context_units?: CaptureUnitState[];
  handles: Record<string, CaptureHandle>;
  /** Effective recipe per job order (JSON). */
  recipes: Record<string, unknown>[];
  instruction: string | null;
  resumed_from: string | null;
  unleased: string[];
  history: { op: string; detail: string; at: string }[];
  /** Parent retry set, when this attempt belongs to one. */
  parent_set?: ParentRetrySet;
  /** Frozen context served by generation_context, including whole source. */
  instructions?: string;
}

function isCaptureRecord(value: unknown): value is CaptureRecord {
  if (!isRecord(value)) return false;
  return (
    value["version"] === 1 &&
    typeof value["attempt"] === "string" &&
    typeof value["request_id"] === "string" &&
    typeof value["source_digest"] === "string" &&
    typeof value["fence"] === "number" &&
    Array.isArray(value["units"]) &&
    isRecord(value["handles"]) &&
    isRecord(value["source_revisions"])
  );
}

/** One scanned job attempt: capture, runner record, live fence. */
export interface ScannedAttempt {
  name: string;
  dir: string;
  capture: CaptureRecord | null;
  record: AttemptRecord | null;
  fence: number;
}

/** Scan every job attempt dir (verified on read; corrupt entries scan null). */
export async function scanAttempts(root: string): Promise<ScannedAttempt[]> {
  let names: string[];
  try {
    names = await readdir(join(root, ATTEMPTS_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const out: ScannedAttempt[] = [];
  for (const name of names.sort()) {
    if (!safeEntry(name) || name === "by-unit") continue;
    const dir = join(root, ATTEMPTS_DIR, name);
    let info: { isDirectory(): boolean } | null = null;
    try {
      info = await stat(dir);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;
    const raw = await readJsonFile(join(dir, CAPTURE_FILE));
    const capture = isCaptureRecord(raw) ? raw : null;
    let record: AttemptRecord | null = null;
    try {
      record = await readAttempt(dir);
    } catch (error) {
      if (!(error instanceof LifecycleError)) throw error;
    }
    out.push({ name, dir, capture, record, fence: await readFence(dir) });
  }
  return out;
}

/** One per-unit attempt index entry. */
export interface UnitAttemptIndex {
  attempt: string;
  unit: string;
  captured_at: string;
  complete: boolean;
  accepted: boolean;
  handles: string[];
}

function isUnitAttemptIndex(value: unknown): value is UnitAttemptIndex {
  if (!isRecord(value)) return false;
  return (
    typeof value["attempt"] === "string" &&
    typeof value["unit"] === "string" &&
    typeof value["captured_at"] === "string" &&
    typeof value["complete"] === "boolean" &&
    typeof value["accepted"] === "boolean" &&
    Array.isArray(value["handles"])
  );
}

/** Write one per-unit attempt index entry. */
async function writeUnitIndex(root: string, entry: UnitAttemptIndex): Promise<void> {
  const dir = join(root, UNIT_INDEX_DIR, entry.unit);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${entry.attempt}.json`), `${JSON.stringify(entry, null, 2)}\n`);
}

/** Remove one per-unit attempt index entry. */
async function removeUnitIndex(root: string, unit: string, attempt: string): Promise<void> {
  await rm(join(root, UNIT_INDEX_DIR, unit, `${attempt}.json`), { force: true });
}

/** Read one unit's attempt index entries, newest first. */
async function readUnitIndex(root: string, unit: string): Promise<UnitAttemptIndex[]> {
  let names: string[];
  try {
    names = await readdir(join(root, UNIT_INDEX_DIR, unit));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const out: UnitAttemptIndex[] = [];
  for (const name of names.sort()) {
    if (!safeEntry(name) || !name.endsWith(".json")) continue;
    const parsed = await readJsonFile(join(root, UNIT_INDEX_DIR, unit, name));
    if (isUnitAttemptIndex(parsed)) out.push(parsed);
  }
  out.sort((a, b) => (a.captured_at < b.captured_at ? 1 : a.captured_at > b.captured_at ? -1 : 0));
  return out;
}

/** Discard/rescope record inside an attempt dir. */
interface DiscardedRecord {
  discarded: { handle: string; unit: string; at: string; reason: string }[];
  rescoped_units: string[];
}

async function readDiscarded(attemptDir: string): Promise<DiscardedRecord> {
  const parsed = await readJsonFile(join(attemptDir, DISCARDED_FILE));
  if (!isRecord(parsed)) return { discarded: [], rescoped_units: [] };
  const discarded = Array.isArray(parsed["discarded"])
    ? (parsed["discarded"] as unknown[]).filter((entry): entry is DiscardedRecord["discarded"][number] => {
        if (!isRecord(entry)) return false;
        return (
          typeof entry["handle"] === "string" &&
          typeof entry["unit"] === "string" &&
          typeof entry["at"] === "string" &&
          typeof entry["reason"] === "string"
        );
      })
    : [];
  const rescoped = Array.isArray(parsed["rescoped_units"])
    ? (parsed["rescoped_units"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];
  return { discarded, rescoped_units: rescoped };
}

async function writeDiscarded(attemptDir: string, record: DiscardedRecord): Promise<void> {
  await writeFile(join(attemptDir, DISCARDED_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

/** Required handles still missing a submission for one attempt/unit scope. */
export function missingHandles(
  capture: CaptureRecord,
  inventory: CandidateSubmission[],
  unitFilter: string | null,
): string[] {
  const submitted = new Set(inventory.map((entry) => entry.handle));
  const missing: string[] = [];
  for (const [handle, issued] of Object.entries(capture.handles)) {
    if (unitFilter !== null && issued.unit !== unitFilter) continue;
    if (issued.required && !submitted.has(handle)) missing.push(handle);
  }
  return missing.sort();
}

/** Whether one attempt's required set is fully submitted (optionally one unit). */
export async function attemptComplete(
  capture: CaptureRecord,
  attemptDir: string,
  unitFilter: string | null,
): Promise<boolean> {
  const inventory = await readCandidateInventory(join(attemptDir, CANDIDATES_DIR));
  return missingHandles(capture, inventory, unitFilter).length === 0;
}

/** Produced-work overlay: every unit's candidates across attempts. */
async function producedOverlay(root: string): Promise<Record<string, unknown>> {
  const attempts = await scanAttempts(root);
  const byUnit = new Map<string, unknown[]>();
  for (const attempt of attempts) {
    if (attempt.capture === null) continue;
    const inventory = await readCandidateInventory(join(attempt.dir, CANDIDATES_DIR));
    const discarded = await readDiscarded(attempt.dir);
    const discardedHandles = new Set(discarded.discarded.map((entry) => entry.handle));
    const units = new Map<string, CandidateSubmission[]>();
    for (const [handle, issued] of Object.entries(attempt.capture.handles)) {
      if (!units.has(issued.unit)) units.set(issued.unit, []);
    }
    for (const entry of inventory) {
      const issued = attempt.capture.handles[entry.handle];
      if (issued === undefined) continue;
      units.get(issued.unit)?.push(entry);
    }
    const acceptedRaw = await readJsonFile(join(attempt.dir, ACCEPTED_FILE));
    const acceptedUnits: string[] = isRecord(acceptedRaw) && Array.isArray(acceptedRaw["units"])
      ? (acceptedRaw["units"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [];
    for (const [unit, entries] of units) {
      const complete = missingHandles(attempt.capture, inventory, unit).length === 0;
      const list = byUnit.get(unit) ?? [];
      list.push({
        attempt: attempt.name,
        captured_at: attempt.capture.captured_at,
        complete,
        accepted: acceptedUnits.includes(unit),
        fenced: attempt.fence > attempt.capture.fence,
        handles: entries.map((entry) => ({
          handle: entry.handle,
          role: entry.role,
          filename: entry.filename,
          bytes: entry.bytes,
          sha256: entry.sha256,
          discarded: discardedHandles.has(entry.handle),
        })),
      });
      byUnit.set(unit, list);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [unit, entries] of [...byUnit.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    out[unit] = {
      candidates_path: `${UNIT_INDEX_DIR}/${unit}`,
      attempts: entries,
    };
  }
  return out;
}

/** Operations overlay: recorded control outcomes, newest-blind id order. */
async function operationsOverlay(root: string): Promise<unknown[]> {
  const records = await listControlRecords(root);
  return records.map((record) => ({
    request_id: record.request_id,
    operation: record.operation,
    state: record.state,
    exit: record.code,
    superseded: record.superseded,
  }));
}

/** One fully resolved capture unit, ready for planning. */
interface ResolvedUnit {
  unit_id: string;
  kind: UnitKind;
  category: RecipeCategory;
  agent: string | null;
  prompt: string;
  contract: SeamContract;
  prompt_changed: boolean;
  span: { start: number; end: number } | null;
  path: string;
  owner: string;
  label: string | null;
  current: Record<string, string> | null;
  /** Live unit.json text at capture (association baseline). */
  record_json: string | null;
}

/** One captured scope: resolved units, revisions, skip notes, digest. */
interface CapturedScope {
  files: string[];
  revisions: Record<string, string>;
  units: ResolvedUnit[];
  context?: ResolvedUnit[];
  skipped: { unit_id: string; reason: string }[];
  digest: string;
  unleased: string[];
}

/** Resolve a scope file against the root (absolute paths pass through). */
function scopeAbs(root: string, file: string): string {
  return resolve(root, file);
}

/**
 * Relativize a scope path for lease coordination, or null when the
 * path cannot be a lease rel (outside the root). Absolute paths
 * inside the root lease by their relative spelling.
 */
function leaseRel(root: string, file: string): string | null {
  const abs = resolve(root, file);
  const rel = relative(resolve(root), abs);
  if (rel.length === 0 || rel.startsWith("..") || resolve(root, rel) !== abs) return null;
  try {
    validateRel(rel.split(sep).join("/"));
  } catch {
    return null;
  }
  return rel.split(sep).join("/");
}

/**
 * Hash every scope file's current bytes (missing files refuse).
 * Keyed by absolute path: status entries and bind evidence carry
 * absolute spellings, and spellings must compare exactly.
 */
async function hashScopeFiles(
  root: string,
  files: string[],
): Promise<Record<string, string>> {
  const revisions: Record<string, string> = {};
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(scopeAbs(root, file), "utf8");
    } catch {
      throw new ControlError(
        EXIT_INVALID,
        "unreadable-input",
        `scope file ${JSON.stringify(file)} does not open for reading`,
        ["pass readable scope files and resend"],
      );
    }
    revisions[scopeAbs(root, file)] = sha256HexText(text);
  }
  return revisions;
}

/**
 * Current group bytes (rel -> sha256, including unit.json) or null
 * when unborn. Reads raw bytes through the journal's group
 * listing, never the intake verdict: adoption and generation
 * change a group's intake state without changing its bytes, and
 * the closure comparison must not mistake one for the other.
 */
async function currentGroupMap(root: string, unit_id: string): Promise<Record<string, string> | null> {
  let rels: string[];
  try {
    rels = await groupFiles(root, unit_id);
  } catch {
    return null;
  }
  if (rels.length === 0) return null;
  const map: Record<string, string> = {};
  for (const rel of rels) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(root, GENERATED_DIR, unit_id, ...rel.split("/")));
    } catch {
      return null;
    }
    map[rel] = sha256HexBytes(bytes);
  }
  return map;
}

/** Live unit.json text, or null when the record is unreadable. */
async function readRecordText(root: string, unit_id: string): Promise<string | null> {
  try {
    return await readFile(join(root, GENERATED_DIR, unit_id, UNIT_FILE), "utf8");
  } catch {
    return null;
  }
}

/** Capture digest over the frozen scope (files, revisions, unit intents). */
function scopeDigest(
  root: string,
  files: string[],
  revisions: Record<string, string>,
  units: { unit_id: string; kind: string; prompt: string; contract: SeamContract }[],
): string {
  const sortedFiles = files.map((file) => scopeAbs(root, file)).sort();
  const sortedRevisions: Record<string, string> = {};
  for (const file of sortedFiles) {
    const revision = revisions[file];
    if (revision !== undefined) sortedRevisions[file] = revision;
  }
  const sortedUnits = [...units]
    .sort((a, b) => (a.unit_id < b.unit_id ? -1 : a.unit_id > b.unit_id ? 1 : 0))
    .map((unit) => ({
      unit_id: unit.unit_id,
      kind: unit.kind,
      prompt: unit.prompt,
      contract: unit.contract,
    }));
  return sha256HexText(stableStringify({ files: sortedFiles, revisions: sortedRevisions, units: sortedUnits }));
}

/** Primary saved filename deciding prepare reuse for one unit kind. */
function primaryForKind(kind: string): string {
  if (kind === "named-trait" || kind === "inline-trait") return "contributions.can";
  if (kind === "keyword" || kind === "view") return "implementation.js";
  return "style.css";
}

/**
 * Validate one capture status entry, throwing on ambiguous, unknown,
 * or seam-missing units. Returns "skip" for orphaned entries.
 */
function checkCaptureEntry(entry: StatusUnit): "skip" | "ok" {
  if (entry.association === "orphaned") return "skip";
  if (entry.association === "ambiguous") {
    const names = entry.candidates.length > 0 ? entry.candidates.join(",") : "(none)";
    throw new ControlError(
      EXIT_INVALID,
      "ambiguous-unit",
      `scope unit ${entry.owner}/${entry.kind}/${entry.label ?? "-"} is ambiguous (candidates: ${names}); reconcile with an explicit bind`,
      ["send a bind request to reconcile the unit, then resend"],
    );
  }
  if (entry.association !== "new" && entry.association !== "retained") {
    throw new Error(`the compiler reported an unknown association ${JSON.stringify(entry.association)}`);
  }
  if (entry.path === null || entry.prompt === null || entry.contract === null) {
    throw new ControlError(
      EXIT_INVALID,
      "missing-capture-seam",
      "the compiler status report carries no prompt/contract seam; rebuild the compiler and resend",
      ["rebuild the compiler binary, then resend"],
    );
  }
  if (!isUnitKind(entry.kind)) {
    throw new Error(`the compiler reported an unknown unit kind ${JSON.stringify(entry.kind)}`);
  }
  return "ok";
}

/**
 * Whether one retained unit's saved output is fresh enough for
 * prepare to reuse it. Binding reserves identity before generation:
 * a bare unit.json from an incomplete attempt never reuses.
 */
async function isFreshSavedOutput(root: string, unit_id: string, kind: string): Promise<boolean> {
  const current = await currentGroupMap(root, unit_id);
  const intake = await readSavedGroup(root, unit_id);
  const primary = primaryForKind(kind);
  return current !== null && intake.ok && intake.group.files.some(file => file.relPath === primary);
}

/**
 * Capture a files scope: status the closure under brief read leases,
 * bind new units through the compiler under the capture sentinel,
 * snapshot current bytes, and freeze the source digest. Prepare mode
 * skips fresh units; fresh/retry capture every prompt including
 * preferred outputs.
 */
async function captureFromFiles(
  ctx: ControlContext,
  header: RequestHeader,
  root: string,
  files: string[],
  mode: "prepare" | "fresh" | "retry",
): Promise<CapturedScope> {
  const unleased: string[] = [];
  const leasePaths: string[] = [];
  for (const file of files) {
    const rel = leaseRel(root, file);
    if (rel === null) {
      unleased.push(file);
    } else {
      leasePaths.push(rel);
    }
  }
  // Canonical capture order: the bind sentinel first, then scope
  // reads, so concurrent captures serialize identically.
  const sentinel = await acquire(root, [CAPTURE_SENTINEL], "write", `gen-capture:${header.request_id}`);
  try {
    const reads = leasePaths.length > 0 ? await acquire(root, leasePaths, "read", `gen-capture:${header.request_id}`) : null;
    try {
      const status = await compilerStatus(ctx, header.request_id, root, files);
      // Do not let a late ambiguous entry follow earlier bind allocations.
      assertResolvableStatus(status);
      const revisions = await hashScopeFiles(root, files);
      const units: ResolvedUnit[] = [];
      const context: ResolvedUnit[] = [];
      const skipped: { unit_id: string; reason: string }[] = [];
      for (const entry of status) {
        if (checkCaptureEntry(entry) === "skip") continue;
        let unit_id = entry.id;
        if (entry.association === "new") {
          if (entry.span === null) {
            throw new ControlError(
              EXIT_INVALID,
              "missing-capture-seam",
              "the compiler status report carries no span for a new unit; rebuild the compiler and resend",
              ["rebuild the compiler binary, then resend"],
            );
          }
          unit_id = await bindNewUnit(ctx, header, root, entry, revisions);
        }
        if (unit_id === null) {
          throw new Error("the compiler reported a retained unit without an id");
        }
        const promptChanged = entry.prompt_changed ?? true;
        let reused = false;
        if (mode === "prepare" && entry.association === "retained" && !promptChanged) {
          // Binding reserves identity before generation. A bare unit.json
          // from an incomplete attempt is not a reusable implementation.
          if (await isFreshSavedOutput(root, unit_id, entry.kind)) {
            skipped.push({ unit_id, reason: "saved output is fresh; prepare reuses it" });
            reused = true;
          }
        }
        const kind = entry.kind as UnitKind;
        const contract = entry.contract as SeamContract;
        const prompt = entry.prompt as string;
        const path = entry.path as string;
        (reused ? context : units).push({
          unit_id,
          kind,
          category: categoryFor(kind),
          agent: contract.profile,
          prompt,
          contract,
          prompt_changed: promptChanged,
          span: entry.span,
          path,
          owner: entry.owner,
          label: entry.label,
          current: await currentGroupMap(root, unit_id),
          record_json: await readRecordText(root, unit_id),
        });
      }
      const digest = scopeDigest(
        root,
        files,
        revisions,
        [...units, ...context].map((unit) => ({ unit_id: unit.unit_id, kind: unit.kind, prompt: unit.prompt, contract: unit.contract })),
      );
      return { files: [...files], revisions, units, context, skipped, digest, unleased: [...unleased] };
    } finally {
      if (reads !== null) await release(root, reads);
    }
  } finally {
    await release(root, sentinel);
  }
}

/** Bind one new scope unit through the compiler; returns its fresh id. */
async function bindNewUnit(
  ctx: ControlContext,
  header: RequestHeader,
  root: string,
  entry: StatusUnit,
  revisions: Record<string, string>,
): Promise<string> {
  const path = entry.path as string;
  const span = entry.span as { start: number; end: number };
  const revision = revisions[path];
  if (revision === undefined) {
    throw new ControlError(EXIT_INVALID, "unreadable-input", `scope file ${JSON.stringify(path)} left the capture`, [
      "resend with readable scope files",
    ]);
  }
  const result = await compilerRequest(ctx, {
    version: 1,
    request_id: `${header.request_id}.bind`,
    operation: "bind",
    root,
    file: path,
    start: span.start,
    end: span.end,
    revision,
    unit: "new",
  });
  if (result.code !== EXIT_OK || result.body["ok"] !== true) {
    throw compilerFailure("bind", result);
  }
  const unit = result.body["unit"];
  if (!isRecord(unit) || typeof unit["id"] !== "string") {
    throw new Error("the compiler bind report carries no unit id");
  }
  return unit["id"] as string;
}

/** Read one saved unit record or refuse with its reconciliation action. */
async function loadUnitRecord(
  root: string,
  unit_id: string,
): Promise<{ record: UnitRecord; recordText: string }> {
  try {
    const text = await readFile(join(root, GENERATED_DIR, unit_id, UNIT_FILE), "utf8");
    return { record: parseUnitRecord(text, unit_id), recordText: text };
  } catch {
    throw new ControlError(EXIT_INVALID, "unknown-unit", `no saved unit ${JSON.stringify(unit_id)} under ${root}`, [
      "send a status request to list saved units",
    ]);
  }
}

/**
 * Consider one status sibling as reused context for an explicit unit
 * selection: retained, unchanged, and carrying a fresh saved group.
 */
async function considerContextCandidate(
  root: string,
  candidate: StatusUnit,
  unit_ids: string[],
  context: Map<string, ResolvedUnit>,
  files: string[],
  revisions: Record<string, string>,
): Promise<void> {
  if (candidate.id === null || unit_ids.includes(candidate.id) || context.has(candidate.id)
    || candidate.association !== "retained" || candidate.prompt_changed !== false
    || candidate.path === null || candidate.prompt === null || candidate.contract === null
    || !isUnitKind(candidate.kind)) return;
  const id = candidate.id;
  const intake = await readSavedGroup(root, id);
  if (!intake.ok || !intake.group.files.some(file => file.relPath === primaryForKind(candidate.kind))) return;
  const kind = candidate.kind as UnitKind;
  const contract = candidate.contract as SeamContract;
  const prompt = candidate.prompt as string;
  const path = candidate.path as string;
  context.set(id, {
    unit_id: id, kind, category: categoryFor(kind),
    agent: contract.profile, prompt, contract,
    prompt_changed: false, span: candidate.span, path, owner: candidate.owner,
    label: candidate.label, current: await currentGroupMap(root, id),
    record_json: await readRecordText(root, id),
  });
  if (!files.includes(path)) {
    files.push(path);
    Object.assign(revisions, await hashScopeFiles(root, [path]));
  }
}

/**
 * Capture explicitly selected units: resolve each id through its
 * saved record plus a fresh status of the owning source. Explicitly
 * selected units are explicitly required: prepare never skips them.
 */
async function captureUnitsById(
  ctx: ControlContext,
  header: RequestHeader,
  root: string,
  unit_ids: string[],
): Promise<CapturedScope> {
  const units: ResolvedUnit[] = [];
  const context = new Map<string, ResolvedUnit>();
  const files: string[] = [];
  const revisions: Record<string, string> = {};
  const unleased: string[] = [];
  for (const unit_id of unit_ids) {
    const { record, recordText } = await loadUnitRecord(root, unit_id);
    const rel = leaseRel(root, record.source.path);
    if (rel === null) unleased.push(record.source.path);
    const reads = rel === null ? null : await acquire(root, [rel], "read", `gen-capture:${header.request_id}`);
    try {
      const status = await compilerStatus(ctx, header.request_id, root, [record.source.path]);
      // A selected ID cannot bypass unresolved siblings in its owning source.
      assertResolvableStatus(status);
      for (const candidate of status) {
        await considerContextCandidate(root, candidate, unit_ids, context, files, revisions);
      }
      const entry = status.find((candidate) => candidate.id === unit_id && candidate.association === "retained");
      if (entry === undefined || entry.prompt === null || entry.contract === null) {
        throw new ControlError(
          EXIT_INVALID,
          "stale-association",
          `saved unit ${JSON.stringify(unit_id)} no longer matches its owning source; reconcile with an explicit bind`,
          ["send a status request to inspect the unit, then bind and resend"],
        );
      }
      if (!files.includes(record.source.path)) {
        files.push(record.source.path);
        const scoped = await hashScopeFiles(root, [record.source.path]);
        revisions[scopeAbs(root, record.source.path)] = scoped[scopeAbs(root, record.source.path)] as string;
      }
      units.push({
        unit_id,
        kind: record.source.kind,
        category: categoryFor(record.source.kind),
        agent: entry.contract.profile,
        prompt: entry.prompt,
        contract: entry.contract,
        prompt_changed: entry.prompt_changed ?? true,
        span: entry.span,
        path: record.source.path,
        owner: record.source.owner,
        label: record.source.label,
        current: await currentGroupMap(root, unit_id),
        record_json: recordText,
      });
    } finally {
      if (reads !== null) await release(root, reads);
    }
  }
  const digest = scopeDigest(
    root,
    files,
    revisions,
    [...units, ...context.values()].map((unit) => ({ unit_id: unit.unit_id, kind: unit.kind, prompt: unit.prompt, contract: unit.contract })),
  );
  return { files, revisions, units, context: [...context.values()], skipped: [], digest, unleased };
}

/** Saved filename for one issued output (the BGI-12 filename join). */
export function savedPathFor(role: string, filename: string): string {
  // The intake primary for server code is `implementation.js`; the
  // BGI-11 packer derives `server.js`/`view.js` from there at pack
  // time. Every other role keeps its logical filename.
  if (role === "server") return "implementation.js";
  return filename;
}

/** Issue session handles for one job's units (assets stay optional). */
function issueJobHandles(units: ResolvedUnit[]): {
  allowed: AllowedTarget[];
  handles: Record<string, CaptureHandle>;
  required: string[];
} {
  const allowed: AllowedTarget[] = [];
  const handles: Record<string, CaptureHandle> = {};
  const required: string[] = [];
  const taken = new Set<string>();
  for (const unit of units) {
    for (const [role, filename] of allowedOutputsFor(unit.kind as McpUnitKind)) {
      const sanitized = unit.unit_id.replace(/[^A-Za-z0-9_-]/g, "-");
      let handle = `${sanitized}-${role}`;
      for (let counter = 2; taken.has(handle); counter += 1) {
        handle = `${sanitized}-${role}-${String(counter)}`;
      }
      taken.add(handle);
      const saved = savedPathFor(role, filename);
      const optional = role === "asset" || (unit.kind === "view" && role !== "server")
        || ((unit.kind === "named-trait" || unit.kind === "inline-trait") && role === "server");
      allowed.push({ handle, role: role as McpRole, kind: unit.kind, filename });
      handles[handle] = { unit: unit.unit_id, role, filename, saved, required: !optional };
      if (!optional) required.push(handle);
    }
  }
  return { allowed, handles, required };
}

/** Render one job's agent prompt from its assigned plus context units. */
function renderJobPrompt(
  job: PlannedJob,
  byId: Map<string, ResolvedUnit>,
  mode: string,
  refineFiles: { path: string; content: string }[],
  instruction: string | null,
  sources: { path: string; content: string }[],
  handles: Record<string, CaptureHandle>,
): string {
  const lines: string[] = [
    `# Generation job (${mode}; ${String(job.units.length)} assigned unit${job.units.length === 1 ? "" : "s"})`,
    "",
    "You implement only the assigned generated units of this Can app. The source defines its behavior and permissions; do not invent operations, change schemas beyond the requested traits, or replace canonical controls.",
    "Call generation_context to obtain the session and allowed handles. Submit UTF-8 code with generation_submit as {session, batch:[{target,role,content_text}]}. Output files are host-owned; do not write files or return code only in chat. Assets are optional. Finish only after every required output has been submitted.",
    "",
    "## Owning output interfaces",
    "Scoped CSS forbids bare universal * selectors, including :host > * + *. Use explicit element/class selectors or supported :where(...) selector forms. Prefer root layout properties such as gap when styling sibling spacing.",
    "Generated view input uses RowView={id,version,fields}. Model data is projected under row.fields: read row.fields.title, row.fields.handle or row.fields.done, never row.title/row.handle/row.done. Row identity and version are row.id and row.version.",
    "Traits: always submit contributions.can. It is a Can source carrier beginning with `app <owning app>`, then `Given`. A named model trait uses a template model named after the trait, e.g. `completable {done:bool=false}`. An inline model trait names its attached model. A field trait uses one field of the attached type with the requested constraints; a named field trait template is `clean {value:text trim min=1}`, while an inline field trait names its model and field. A pure validator on a required native text field may additionally submit a server ES module exporting `check(value)` returning a boolean (or Promise of boolean); this source-derived state.field-validation@1 binding checks the normalized post-hook value before State publishes writes, history or unique claims. False, nonboolean and exceptions refuse with canonical validation. A checker-only template can use `value:text` without extra constraints. Do not repair or mutate input, access network/storage, add authority, or supply a server module for a model trait, nullable or other field type. Do not redeclare unrelated fields.",
    "Keywords: the admitted v1 source signature (target:model, field:field(target,text)) binds the compiler-owned pure state.unique-key@1 producer. Submit a JavaScript ES module exporting `canonicalKey(value)` with an exact text input and text result. No contributions carrier, metadata, store, network, permissions, or effect handles. The compiler owns uniqueness, transactions, namespaces, and source applications. Preserve stored spelling; implement the prompt's key semantics only.",
    "Views: submit an ES module exporting `render({row, bindings, ui})` returning HTML (or a Promise of HTML). `row` is already admitted data; escape displayed values with ui.escapeHtml and attributes with ui.escapeAttr. `bindings` contains complete canonical HTML keyed by source child kind in source order (card, edit, delete, form, action, actions, button, text, content, history; repeated names add 2, 3, ...). An action button keeps the name button even when implemented by a protected form. A locally guarded child may supply an empty binding; whole-view guards prevent the renderer call. Include each binding exactly once, unchanged. A card binding includes its source-authored content, primary footer and secondary heading menu; Can owns the whole card composition and design. Do not rebuild the card, duplicate its metadata, or extract or independently position its nested controls. Primary and secondary are labeled checked actions allowed only in semantic owner regions: page heading, card footer/header, list/table row, modal/drawer actions slot, detail drawer, or canonical form submission. Views and annotation/layout wrappers such as tooltip, tab, fieldset or join are not action owners. Do not invent controls, endpoints or hidden fields. Do not hide or restyle canonical controls. Optional `mount(root,presentation)` in the SAME module enhances only its instance and returns cleanup. Do not access browser globals at module scope. The host creates the instance root and supplies {view,useId,row}. View style.css and assets are optional.",
    "Styles: submit ordinary CSS for the attached component and its owned parts. Use :host for the attachment root, :host(.class) for a root condition, and ordinary selectors for owned descendants. The compiler scopes selectors and local custom properties/keyframes. Do not use html, body, :root, :scope, :has(), global escapes, @import, remote URLs, or redefine shared theme variables. Read existing --color-base-100/200/300, --color-base-content, --color-primary, --color-accent, --color-error, --radius-box/field and --border with var(). Keep accessible focus, usable contrast and responsive layouts. Coordinate all Then intents and component uses shown below. Do not hide canonical controls or their validation states. Primary/secondary controls and standard form submits are shared design boundaries: do not restyle their internals, typography, color, dimensions or placement within their owning action region.",
    "",
  ];
  for (const source of sources) {
    lines.push(`## Captured source ${JSON.stringify(source.path)}`, "```can", source.content, "```", "");
  }
  // Assigned units render first, then context-only units: every
  // assigned prompt reaches the agent even when the context set
  // does not cover it (frontend jobs carry the whole Then context
  // plus their own assignment; Given jobs render their assignment).
  const assignedIds = new Set(job.units.map((unit) => unit.unit_id));
  const ordered = [
    ...job.units,
    ...job.contextUnits.filter((unit) => !assignedIds.has(unit.unit_id)),
  ];
  for (const context of ordered) {
    const unit = byId.get(context.unit_id);
    if (unit === undefined) continue;
    const assigned = assignedIds.has(unit.unit_id);
    lines.push(
      `## Unit ${unit.unit_id} (${unit.kind}${unit.label === null ? "" : ` ${unit.label}`}; ${assigned ? "assigned" : "context"})`,
      `Contract: target=${unit.contract.target ?? "-"} profile=${unit.contract.profile ?? "-"} signature=${unit.contract.signature ?? "-"}`,
      `Prompt: ${unit.prompt}`,
      `Outputs: ${JSON.stringify(Object.entries(handles).filter(([, output]) => output.unit === unit.unit_id).map(([handle, output]) => ({ handle, role: output.role, required: output.required })))}`,
      "",
    );
  }
  if (mode === "fresh" || mode === "retry") {
    lines.push("Design from the source prompts above; current saved code is not the design baseline.", "");
  }
  for (const file of refineFiles) {
    lines.push(`## Current ${file.path}`, "```", file.content, "```", "");
  }
  if (instruction !== null) {
    lines.push("## Instruction", instruction, "");
  }
  lines.push("Submit every required output through generation_submit; host placement is final.");
  return lines.join("\n");
}

/** Snapshot scope files into one attempt dir (frozen capture evidence). */
async function writeSnapshot(
  root: string,
  attemptDir: string,
  files: string[],
): Promise<{ file: string; stored: string }[]> {
  const snapshotDir = join(attemptDir, SNAPSHOT_DIR);
  await mkdir(snapshotDir, { recursive: true });
  const manifest: { file: string; stored: string }[] = [];
  let index = 0;
  for (const file of files) {
    index += 1;
    const base = basename(file).length > 0 ? basename(file) : "input";
    const stored = `${String(index)}-${base}`;
    let bytes: Buffer;
    try {
      bytes = await readFile(scopeAbs(root, file));
    } catch {
      throw new ControlError(EXIT_INVALID, "unreadable-input", `scope file ${JSON.stringify(file)} left the capture`, [
        "resend with readable scope files",
      ]);
    }
    await writeFile(join(snapshotDir, stored), bytes);
    manifest.push({ file, stored });
  }
  await writeFile(join(snapshotDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Existing capture state also describes a readonly saved dependency. */
function contextState(unit: ResolvedUnit): CaptureUnitState {
  return { ...unit, contract: { ...unit.contract }, current: unit.current === null ? null : { ...unit.current }, job: -1 };
}

async function snapshotContext(root: string, attemptDir: string, context: CaptureUnitState[]): Promise<void> {
  const paths = context.flatMap(unit => Object.keys(unit.current ?? {}).map(path => `${GENERATED_DIR}/${unit.unit_id}/${path}`));
  const leases = paths.length === 0 ? null : await acquire(root, paths, "read", "gen-context");
  try {
    for (const unit of context) {
      if (compareGroupMaps(unit.current, await currentGroupMap(root, unit.unit_id)) !== null
        || await compareRecordSemantics(root, unit) !== null) {
        throw new ControlError(EXIT_CONFLICT, "context-changed", `saved dependency ${JSON.stringify(unit.unit_id)} changed after capture; recapture before generation`);
      }
      await cp(join(root, GENERATED_DIR, unit.unit_id), join(attemptDir, SNAPSHOT_DIR, GENERATED_DIR, unit.unit_id), { recursive: true });
    }
  } finally { if (leases !== null) await release(root, leases); }
}

/** One executed job: its attempt, outcome, and disk completion. */
interface ExecutedJob {
  order: number;
  key: string;
  recipe: EffectiveRecipe;
  units: string[];
  attempt: string;
  attemptDir: string;
  outcome: RequestOutcome;
  complete: boolean;
}

/** Recipe overrides carried by an execution request. */
function overridesOf(params: {
  profile?: string;
  runner?: string;
  model?: string;
  max_attempts?: number;
  timeout_seconds?: number;
  native?: Record<string, string | number | boolean>;
}): RunOverrides {
  return {
    ...(params.profile === undefined ? {} : { profile: params.profile }),
    ...(params.runner === undefined ? {} : { runner: params.runner }),
    ...(params.model === undefined ? {} : { model: params.model }),
    ...(params.max_attempts === undefined ? {} : { max_attempts: params.max_attempts }),
    ...(params.timeout_seconds === undefined ? {} : { timeout_seconds: params.timeout_seconds }),
    ...(params.native === undefined ? {} : { native: params.native }),
  };
}

/** One planned job: its attempt, prompt, handles, and frozen capture. */
interface PlannedEntry {
  job: PlannedJob;
  attempt: string;
  attemptDir: string;
  jobUnits: ResolvedUnit[];
  issued: ReturnType<typeof issueJobHandles>;
  prompt: string;
  capture: CaptureRecord;
}

/** Read every scope source, refusing when one changed after capture. */
async function readExecutionSources(
  root: string,
  scope: CapturedScope,
): Promise<{ path: string; content: string }[]> {
  const sources: { path: string; content: string }[] = [];
  for (const file of scope.files) {
    const content = await readFile(scopeAbs(root, file), "utf8");
    if (sha256HexText(content) !== scope.revisions[scopeAbs(root, file)]) {
      throw new ControlError(EXIT_CONFLICT, "source-changed", `scope file ${JSON.stringify(file)} changed after capture; recapture before generation`);
    }
    sources.push({ path: relative(root, scopeAbs(root, file)), content });
  }
  return sources;
}

/**
 * Freeze every planned job attempt: snapshot sources, snapshot
 * context, read the fence, write the capture, and index its units.
 */
async function planExecutionJobs(
  root: string,
  header: RequestHeader,
  jobs: PlannedJob[],
  byId: Map<string, ResolvedUnit>,
  mode: string,
  refineFiles: { path: string; content: string }[],
  instruction: string | null,
  sources: { path: string; content: string }[],
  scope: CapturedScope,
  parentSet: ParentRetrySet,
  context: CaptureUnitState[],
  now: () => number,
  ctx: ControlContext,
): Promise<PlannedEntry[]> {
  const planned: PlannedEntry[] = [];
  for (const job of jobs) {
    const attempt = attemptFor(header.request_id, job.order);
    const attemptDir = join(root, ATTEMPTS_DIR, attempt);
    const jobUnits = job.units
      .map((unit) => byId.get(unit.unit_id))
      .filter((unit): unit is ResolvedUnit => unit !== undefined);
    const issued = issueJobHandles(jobUnits);
    const prompt = renderJobPrompt(job, byId, mode, refineFiles, instruction, sources, issued.handles);
    await writeSnapshot(root, attemptDir, scope.files);
    await snapshotContext(root, attemptDir, context);
    const fence = await readFence(attemptDir);
    const capture: CaptureRecord = {
      version: 1,
      attempt,
      request_id: header.request_id,
      operation: header.operation,
      mode,
      root,
      files: [...scope.files],
      app_id: root,
      source_digest: scope.digest,
      captured_at: new Date(now()).toISOString(),
      fence,
      source_revisions: { ...scope.revisions },
      units: jobUnits.map((unit, index) => ({
        unit_id: unit.unit_id,
        kind: unit.kind,
        category: unit.category,
        agent: unit.agent,
        prompt: unit.prompt,
        contract: { ...unit.contract },
        prompt_changed: unit.prompt_changed,
        current: unit.current === null ? null : { ...unit.current },
        span: unit.span === null ? null : { ...unit.span },
        job: index,
        owner: unit.owner,
        label: unit.label,
        path: unit.path,
        record_json: unit.record_json,
      })),
      context_units: context,
      handles: Object.fromEntries(Object.entries(issued.handles).map(([handle, entry]) => [handle, { ...entry }])),
      recipes: [{ ...job.recipe } as unknown as Record<string, unknown>],
      instruction,
      instructions: prompt,
      resumed_from: null,
      unleased: [...scope.unleased],
      history: [],
      parent_set: { request_id: parentSet.request_id, attempts: [...parentSet.attempts], units: [...parentSet.units] },
    };
    await writeFile(join(attemptDir, CAPTURE_FILE), `${JSON.stringify(capture, null, 2)}\n`);
    for (const unit of jobUnits) {
      const handles = Object.entries(issued.handles)
        .filter(([, entry]) => entry.unit === unit.unit_id)
        .map(([handle]) => handle);
      await writeUnitIndex(root, {
        attempt,
        unit: unit.unit_id,
        captured_at: capture.captured_at,
        complete: false,
        accepted: false,
        handles,
      });
    }
    ctx.onEvent?.(`job-${String(job.order)}-planned`, `attempt ${JSON.stringify(attempt)} captures ${String(jobUnits.length)} units`);
    planned.push({ job, attempt, attemptDir, jobUnits, issued, prompt, capture });
  }
  return planned;
}

/** Refuse when Given preparation left incomplete candidates behind. */
function assertGivenJobsComplete(givenJobs: ExecutedJob[]): void {
  if (givenJobs.some((prior) => !prior.complete || prior.outcome.state !== "candidate")) {
    const summaries = givenJobs.slice(0, 16).map(prior => {
      const detail = prior.outcome.detail.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
        .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
        .replace(/https?:\/\/[^\s"']+/g, "[native endpoint]").slice(0, 1024);
      return `${prior.attempt}: ${prior.outcome.state}, exit=${prior.outcome.exit}, tries=${prior.outcome.tries}, complete=${prior.complete}; ${detail}`;
    });
    throw new ControlError(EXIT_VALIDATION, "given-preparation-incomplete", `Given preparation did not reach complete candidates; dependent frontend jobs remain planned and every current output is preserved.\n${summaries.join("\n")}`, ["inspect the named Given attempts, then resend corrected work with a new request id"]);
  }
}

/** Render the validated Given preparation as appended job context. */
async function buildGivenContextLines(
  givenScope: PromotionUnit[],
  givenPreparation: { unit_id: string; fingerprint: string }[],
): Promise<string> {
  const lines = ["", "## Checked Given preparation (candidate schema; not promoted)", JSON.stringify(givenPreparation)];
  for (const prepared of givenScope) {
    lines.push(`### Unit ${prepared.unit_id} (${prepared.record.source.kind}; ${prepared.record.source.label ?? "inline"})`);
    if (prepared.replacements.length === 0) {
      const contribution = join(prepared.attemptDir, SNAPSHOT_DIR, GENERATED_DIR, prepared.unit_id, "contributions.can");
      if (await fileExists(contribution)) lines.push("```can", await readFile(contribution, "utf8"), "```");
    }
    for (const replacement of prepared.replacements) {
      if (replacement.path === "contributions.can" && replacement.bytes !== null) {
        lines.push("```can", Buffer.from(replacement.bytes).toString("utf8"), "```");
      }
    }
  }
  return lines.join("\n");
}

/**
 * Validate Given preparation before the first frontend job and share
 * it with every frontend recipe. Returns null when no Given work
 * exists; otherwise the preparation plus the current prompt.
 */
async function ensureGivenPreparation(
  ctx: ControlContext,
  header: RequestHeader,
  root: string,
  entry: PlannedEntry,
  planned: PlannedEntry[],
  executed: ExecutedJob[],
  byId: Map<string, ResolvedUnit>,
  context: CaptureUnitState[],
): Promise<{ preparation: { unit_id: string; fingerprint: string }[]; prompt: string; scopeSize: number } | null> {
  const givenJobs = executed.filter((prior) => prior.units.some((id) => byId.get(id)?.category === "given"));
  const retainedGiven: PromotionUnit[] = [];
  for (const unit of context.filter(unit => unit.category === "given")) {
    retainedGiven.push({ unit_id: unit.unit_id, record: parseUnitRecord(unit.record_json!, unit.unit_id), capture: entry.capture, attemptDir: entry.attemptDir, replacements: [], origins: [] });
  }
  if (givenJobs.length > 0 || retainedGiven.length > 0) {
    assertGivenJobsComplete(givenJobs);
    const givenScope = [...(givenJobs.length === 0 ? [] : await promotionScopeFromAttempts(root, givenJobs.map((prior) => prior.attemptDir))), ...retainedGiven];
    const preparation = await validateCandidateSet(ctx, header, root, givenScope);
    const checkedContext = await buildGivenContextLines(givenScope, preparation);
    // Every frontend recipe consumes the same validated Given output set.
    // Persist it in the existing capture/MCP instructions before launch.
    for (const frontend of planned.filter((candidate) => candidate.jobUnits.some((unit) => unit.category === "frontend"))) {
      frontend.prompt += checkedContext;
      frontend.capture.instructions = frontend.prompt;
      await writeFile(join(frontend.attemptDir, CAPTURE_FILE), `${JSON.stringify(frontend.capture, null, 2)}\n`);
    }
    ctx.onEvent?.("given-prepared", `${String(givenScope.length)} Given candidate units validated before frontend generation`);
    return { preparation, prompt: entry.prompt, scopeSize: givenScope.length };
  }
  return null;
}

/** Launch one planned job through its recipe with the control context. */
async function launchPlannedJob(
  ctx: ControlContext,
  header: RequestHeader,
  root: string,
  scope: CapturedScope,
  mode: string,
  job: PlannedJob,
  jobUnits: ResolvedUnit[],
  issued: ReturnType<typeof issueJobHandles>,
  prompt: string,
  attemptDir: string,
  bridge: McpBridge | null,
  givenPreparation: { unit_id: string; fingerprint: string }[],
  now: () => number,
): Promise<RequestOutcome> {
  return executeJob({
    request_id: `${header.request_id}.job${String(job.order)}`,
    input: { operation: header.operation, mode, capture: scope.digest, job: job.order, units: jobUnits.map((unit) => unit.unit_id), given_preparation: givenPreparation },
    recipe: job.recipe,
    source_digest: scope.digest,
    allowed: issued.allowed,
    prompt,
    snapshotDir: join(attemptDir, SNAPSHOT_DIR),
    attemptDir,
    stateDir: join(root, ".can/gen"),
    coordinationRoot: root,
    assertCurrent: () => withControlClaim(ctx, async () => {}),
    required: issued.required,
    mcpBridge: bridge,
    ...(ctx.registry === undefined ? {} : { registry: ctx.registry }),
    now,
    ...(ctx.codexHome === undefined ? {} : { codexHome: ctx.codexHome }),
    ...(ctx.profileName === undefined ? {} : { profileName: ctx.profileName }),
    ...(ctx.preflight === undefined ? {} : { preflight: ctx.preflight }),
    ...(ctx.resolveExecutable === undefined ? {} : { resolveExecutable: ctx.resolveExecutable }),
    onEvent: (phase, detail) => ctx.onEvent?.(`job-${String(job.order)}-${phase}`, detail),
    ...(ctx.onSession === undefined ? {} : { onSession: ctx.onSession }),
  });
}

/** Execute every planned job for one captured scope. */
async function executeCaptured(
  ctx: ControlContext,
  header: RequestHeader,
  root: string,
  scope: CapturedScope,
  mode: string,
  recipeParams: {
    settings?: string;
    profile?: string;
    runner?: string;
    model?: string;
    max_attempts?: number;
    timeout_seconds?: number;
    native?: Record<string, string | number | boolean>;
  },
  refineFiles: { path: string; content: string }[],
  instruction: string | null,
): Promise<ExecutedJob[]> {
  const now = ctx.now ?? Date.now;
  if (scope.units.length === 0) return [];
  const loaded = await loadSettings(root, recipeParams.settings);
  const overrides = overridesOf(recipeParams);
  const context = (scope.context ?? []).map(contextState);
  const byId = new Map([...scope.units, ...(scope.context ?? [])].map((unit) => [unit.unit_id, unit]));
  const sources = await readExecutionSources(root, scope);
  const closure: ActiveClosure = {
    app_id: root,
    root,
    source_digest: scope.digest,
    units: scope.units.map((unit) => ({
      unit_id: unit.unit_id,
      kind: unit.kind,
      category: unit.category,
      prompt: unit.prompt,
      agent: unit.agent,
    })),
  };
  const jobs = buildRetryJobs(closure, (unit: CaptureUnit) => {
    const resolved = byId.get(unit.unit_id);
    if (resolved === undefined) {
      throw new ControlError(EXIT_INVALID, "unknown-unit", `planned unit ${JSON.stringify(unit.unit_id)} left the capture`);
    }
    return resolveRecipe(loaded, resolved.category, resolved.agent, overrides);
  });
  // The complete required parent set is recorded before any
  // launch: every job capture carries it, so a gate failure on an
  // early job still leaves the full sibling set on disk for
  // inspection, and acceptance can require the whole set.
  const parentAttempts = jobs.map((job) => attemptFor(header.request_id, job.order));
  const parentUnits = [...new Set(jobs.flatMap((job) => job.units.map((unit) => unit.unit_id)))].sort();
  const parentSet: ParentRetrySet = { request_id: header.request_id, attempts: parentAttempts, units: parentUnits };
  const bridge = ctx.mcpBridge === undefined ? defaultMcpBridge() : ctx.mcpBridge;
  const planned = await withControlClaim(ctx, () => planExecutionJobs(root, header, jobs, byId, mode, refineFiles, instruction, sources, scope, parentSet, context, now, ctx));
  const executed: ExecutedJob[] = [];
  let givenPreparation: { unit_id: string; fingerprint: string }[] = [];
  let givenPrepared = false;
  for (const entry of planned) {
    const { job, attempt, attemptDir, jobUnits, issued, capture } = entry;
    let prompt = entry.prompt;
    if (jobUnits.some((unit) => unit.category === "frontend") && !givenPrepared) {
      const prepared = await ensureGivenPreparation(ctx, header, root, entry, planned, executed, byId, context);
      if (prepared !== null) {
        givenPreparation = prepared.preparation;
        prompt = prepared.prompt;
      }
      givenPrepared = true;
    }
    const outcome = await launchPlannedJob(ctx, header, root, scope, mode, job, jobUnits, issued, prompt, attemptDir, bridge, givenPreparation, now);
    const inventory = await readCandidateInventory(join(attemptDir, CANDIDATES_DIR));
    const complete = missingHandles(capture, inventory, null).length === 0;
    for (const unit of jobUnits) {
      const handles = Object.entries(issued.handles)
        .filter(([, handleEntry]) => handleEntry.unit === unit.unit_id)
        .map(([handle]) => handle);
      await writeUnitIndex(root, {
        attempt,
        unit: unit.unit_id,
        captured_at: capture.captured_at,
        complete: missingHandles(capture, inventory, unit.unit_id).length === 0,
        accepted: false,
        handles,
      });
    }
    executed.push({
      order: job.order,
      key: job.key,
      recipe: job.recipe,
      units: jobUnits.map((unit) => unit.unit_id),
      attempt,
      attemptDir,
      outcome,
      complete,
    });
  }
  return executed;
}

/** Aggregate one execution request's jobs into a candidate envelope. */
function executionEnvelope(
  header: RequestHeader,
  jobs: ExecutedJob[],
  skipped: { unit_id: string; reason: string }[],
  accepted: { run: string; files: number; units: string[] } | null,
): ControlResult {
  const attempts = jobs.map((job) => ({
    attempt: job.attempt,
    units: job.units,
    state: job.outcome.state,
    exit: job.outcome.exit,
    detail: job.outcome.detail,
    submission_complete: job.outcome.submission_complete,
    disk_complete: job.complete,
    qualified: job.outcome.qualified,
    tries: job.outcome.tries,
  }));
  const complete = jobs.length > 0 && jobs.every((job) => job.complete);
  if (accepted !== null) {
    return {
      code: EXIT_OK,
      envelope: okEnvelope(
        header,
        "accepted",
        { attempts, skipped, complete, accepted, qualified: true },
        ["rebuild from the promoted saved groups with zero AI"],
      ),
    };
  }
  const states = new Set(jobs.map((job) => job.outcome.state));
  if (states.size === 0 || (states.size === 1 && states.has("candidate"))) {
    const empty = jobs.length === 0;
    return {
      code: EXIT_OK,
      envelope: okEnvelope(
        header,
        "candidate",
        {
          attempts,
          skipped,
          complete,
          accepted: false,
          qualified: false,
          ...(empty ? { note: "no units required generation; every scoped unit reuses its saved output" } : {}),
        },
        complete
          ? ["validate the candidate set, then accept it"]
          : ["inspect the incomplete attempts, then retry or refine with a new request id"],
      ),
    };
  }
  const exit = states.has("unknown") ? EXIT_UNKNOWN : states.has("failed") ? EXIT_RUNNER : EXIT_OK;
  const state = states.has("unknown")
    ? "unknown"
    : states.has("failed")
      ? "failed"
      : [...states][0] ?? "candidate";
  return {
    code: exit,
    envelope: resultEnvelope(
      header,
      false,
      state,
      {
        attempts,
        skipped,
        complete,
        accepted: false,
        qualified: false,
        error: {
          code: state === "unknown" ? "unknown-completion" : "runner-failure",
          message: "one or more jobs did not reach candidates; inspect the attempts",
        },
      },
      ["inspect the failed attempts, then resend corrected work with a new request id"],
    ),
  };
}

/** `generate`: scoped prepare/fresh execution with optional composed acceptance. */
async function runGenerate(
  header: RequestHeader,
  params: GenerateParams,
  ctx: ControlContext,
): Promise<ControlResult> {
  const scope =
    params.files !== undefined
      ? await captureFromFiles(ctx, header, params.root, params.files, params.mode as "prepare" | "fresh")
      : await captureUnitsById(ctx, header, params.root, params.unit_ids as string[]);
  const jobs = await executeCaptured(ctx, header, params.root, scope, params.mode, params, [], null);
  if (params.accept === true) {
    const composed = await composeAcceptance(ctx, header, params.root, jobs);
    if (composed !== null) return composed;
  }
  return executionEnvelope(header, jobs, scope.skipped, null);
}

/** `refine`: one unit from its current implementation plus an instruction. */
async function runRefine(
  header: RequestHeader,
  params: RefineParams,
  ctx: ControlContext,
): Promise<ControlResult> {
  const scope = await captureUnitsById(ctx, header, params.root, [params.unit_id]);
  const unit = scope.units[0];
  if (unit === undefined) {
    throw new ControlError(EXIT_INVALID, "unknown-unit", `no saved unit ${JSON.stringify(params.unit_id)} under ${params.root}`);
  }
  const intake = await readSavedGroup(params.root, params.unit_id);
  if (!intake.ok || intake.group.files.length === 0) {
    throw new ControlError(
      EXIT_INVALID,
      "no-current-baseline",
      `unit ${JSON.stringify(params.unit_id)} has no current implementation to refine`,
      [`send a generate request to prepare the unit's saved group, then refine`],
    );
  }
  const instruction = await readInstruction(params, ctx, params.root);
  const refineFiles = intake.group.files.map((file) => {
    let content: string;
    try {
      content = Buffer.from(file.bytes).toString("utf8");
    } catch {
      content = `<binary ${String(file.bytes.length)} bytes>`;
    }
    return { path: file.relPath, content };
  });
  const jobs = await executeCaptured(ctx, header, params.root, scope, "refine", params, refineFiles, instruction);
  if (params.accept === true) {
    const composed = await composeAcceptance(ctx, header, params.root, jobs);
    if (composed !== null) return composed;
  }
  return executionEnvelope(header, jobs, scope.skipped, null);
}

/** Read a refine instruction through its exactly-one carrier. */
async function readInstruction(params: RefineParams, ctx: ControlContext, root: string): Promise<string> {
  if (params.instruction !== undefined) return params.instruction;
  if (params.instruction_file !== undefined) {
    const abs = resolve(root, params.instruction_file);
    if (relative(resolve(root), abs).startsWith("..")) {
      throw new ControlError(EXIT_INVALID, "invalid-param", "the instruction file stays inside the request root");
    }
    let text: string;
    try {
      text = await readFile(abs, "utf8");
    } catch {
      throw new ControlError(EXIT_INVALID, "instruction-unreadable", `instruction file ${JSON.stringify(params.instruction_file)} does not read`, [
        "pass a readable instruction file and resend",
      ]);
    }
    if (text.length === 0) {
      throw new ControlError(EXIT_INVALID, "invalid-param", "the instruction file is empty", [
        "pass a non-empty instruction and resend",
      ]);
    }
    return text;
  }
  const stdinText = ctx.stdinText ?? "";
  if (stdinText.length === 0) {
    throw new ControlError(
      EXIT_INVALID,
      "exclusive-carrier",
      "instruction_stdin needs the instruction on stdin beside --request FILE",
      ["send the request with --request FILE and pipe the instruction on stdin"],
    );
  }
  return stdinText;
}

/** `retry`: fresh full-app capture of every prompt, preferred outputs included. */
async function runRetry(
  header: RequestHeader,
  params: RetryParams,
  ctx: ControlContext,
): Promise<ControlResult> {
  const scope = await captureFromFiles(ctx, header, params.root, params.files, "retry");
  if (scope.units.length === 0) {
    throw new ControlError(EXIT_INVALID, "empty-closure", "the retry scope holds no generation prompts", [
      "scope files carrying generation units and resend",
    ]);
  }
  const jobs = await executeCaptured(ctx, header, params.root, scope, "retry", params, [], null);
  if (params.accept === true) {
    const composed = await composeAcceptance(ctx, header, params.root, jobs);
    if (composed !== null) return composed;
  }
  return executionEnvelope(header, jobs, scope.skipped, null);
}

/**
 * Composed `accept: true`: the request's produced attempts validate
 * and promote together through one coordinated run journal, using
 * the same checks as the separate operations. Returns null when the
 * set is incomplete (candidates stay candidates).
 */
async function composeAcceptance(
  ctx: ControlContext,
  header: RequestHeader,
  root: string,
  jobs: ExecutedJob[],
): Promise<ControlResult | null> {
  // A prepare reuse has no candidate set to promote. Keep its skipped-unit
  // report instead of misreporting successful reuse as incomplete output.
  if (jobs.length === 0) return null;
  const incomplete = jobs.filter((job) => !job.complete);
  if (incomplete.length > 0) {
    const attempts = jobs.map((job) => ({
      attempt: job.attempt,
      units: job.units,
      state: job.outcome.state,
      submission_complete: job.outcome.submission_complete,
      disk_complete: job.complete,
    }));
    return {
      code: EXIT_OK,
      envelope: okEnvelope(
        header,
        "candidate",
        {
          attempts,
          complete: false,
          accepted: false,
          qualified: false,
          note: "the produced set is incomplete; acceptance needs every required output",
        },
        ["inspect the incomplete attempts, then retry or refine with a new request id"],
      ),
    };
  }
  const scope = await promotionScopeFromAttempts(root, jobs.map((job) => job.attemptDir));
  await validateCandidateSet(ctx, header, root, scope, true);
  const promoted = await promoteSet(root, header, scope, runFor("run", header.request_id), "composed accept:true", ctx);
  return executionEnvelope(header, jobs, [], {
    run: promoted.run,
    files: promoted.files,
    units: scope.map((entry) => entry.unit_id),
  });
}

/** One unit's promotion inputs: capture, attempt, replacements. */
export interface PromotionUnit {
  unit_id: string;
  record: UnitRecord;
  capture: CaptureRecord;
  attemptDir: string;
  replacements: Replacement[];
  /** Candidate handle behind each replacement (parallel to replacements). */
  origins: (string | null)[];
  /** Authored interface bytes actually validated, including retained dependencies. */
  checkedDeclarations?: Record<string, string | null>;
}

/** Read one saved record or refuse with the unit's reconciliation action. */
async function requireRecord(root: string, unit_id: string): Promise<UnitRecord> {
  let text: string;
  try {
    text = await readFile(join(root, GENERATED_DIR, unit_id, UNIT_FILE), "utf8");
  } catch {
    throw new ControlError(EXIT_INVALID, "unknown-unit", `no saved unit ${JSON.stringify(unit_id)} under ${root}`, [
      "send a status request to list saved units",
    ]);
  }
  try {
    return parseUnitRecord(text, unit_id);
  } catch (error) {
    throw new ControlError(
      EXIT_INVALID,
      "incompatible-record",
      `saved unit ${JSON.stringify(unit_id)} is incompatible: ${error instanceof Error ? error.message : String(error)}`,
      ["send a bind request to reconcile the unit's association"],
    );
  }
}

/**
 * Build the promotion scope for whole attempts: every unit's
 * submitted candidates mapped through the capture handle map, plus
 * the refreshed unit record each promotion carries. Discarded
 * handles stay out; their required slots fail completeness first.
 */
async function promotionScopeFromAttempts(
  root: string,
  attemptDirs: string[],
): Promise<PromotionUnit[]> {
  const scope: PromotionUnit[] = [];
  for (const attemptDir of attemptDirs) {
    const raw = await readJsonFile(join(attemptDir, CAPTURE_FILE));
    if (!isCaptureRecord(raw)) {
      throw new ControlError(EXIT_INVALID, "unknown-attempt", `attempt at ${JSON.stringify(attemptDir)} carries no capture`, [
        "send a status request to list attempts with candidates",
      ]);
    }
    const inventory = await readCandidateInventory(join(attemptDir, CANDIDATES_DIR));
    const discarded = await readDiscarded(attemptDir);
    const discardedHandles = new Set(discarded.discarded.map((entry) => entry.handle));
    const missing = missingHandles(raw, inventory.filter((entry) => !discardedHandles.has(entry.handle)), null);
    if (missing.length > 0) {
      throw new ControlError(
        EXIT_VALIDATION,
        "incomplete-set",
        `attempt ${JSON.stringify(raw.attempt)} is incomplete; missing required outputs: ${missing.join(", ")}`,
        ["inspect the attempt, then retry or refine with a new request id"],
      );
    }
    for (const unit of raw.units) {
      const record = await requireRecord(root, unit.unit_id);
      const replacements: Replacement[] = [];
      const origins: (string | null)[] = [];
      const promoted: Record<string, string> = {};
      for (const entry of inventory) {
        const issued = raw.handles[entry.handle];
        if (issued === undefined || issued.unit !== unit.unit_id || discardedHandles.has(entry.handle)) {
          continue;
        }
        let bytes: Buffer;
        try {
          bytes = await readFile(entry.candidate);
        } catch {
          throw new ControlError(
            EXIT_VALIDATION,
            "candidate-broken",
            `attempt ${JSON.stringify(raw.attempt)} records handle ${JSON.stringify(entry.handle)} but its bytes are gone`,
            ["inspect the attempt, then retry or refine with a new request id"],
          );
        }
        replacements.push({ unit: unit.unit_id, path: issued.saved, bytes: new Uint8Array(bytes) });
        origins.push(entry.handle);
        promoted[issued.saved] = sha256HexBytes(bytes);
      }
      replacements.push({ unit: unit.unit_id, path: UNIT_FILE, bytes: promotionRecordBytes(raw, unit, record, promoted) });
      origins.push(null);
      scope.push({ unit_id: unit.unit_id, record, capture: raw, attemptDir, replacements, origins });
    }
  }
  if (scope.length === 0) {
    throw new ControlError(EXIT_VALIDATION, "incomplete-set", "the acceptance scope holds no units", [
      "produce candidates before accepting",
    ]);
  }
  return scope;
}

/**
 * The unit record a promotion carries: capture-fresh contract and
 * source evidence, preserved original fingerprints for unpromoted
 * files, refreshed fingerprints for promoted files, and truthful
 * generated provenance.
 */
function promotionRecordBytes(
  capture: CaptureRecord,
  unit: CaptureUnitState,
  record: UnitRecord,
  promoted: Record<string, string>,
): Uint8Array {
  const runner = typeof capture.recipes[0]?.["runner"] === "string" ? (capture.recipes[0]?.["runner"] as string) : null;
  const model = typeof capture.recipes[0]?.["model"] === "string" ? (capture.recipes[0]?.["model"] as string) : null;
  const next: UnitRecord = {
    abi_version: record.abi_version,
    id: record.id,
    source: {
      ...record.source,
      revision: capture.source_revisions[scopeAbs(capture.root, record.source.path)] ?? capture.source_revisions[record.source.path] ?? record.source.revision,
      start: unit.span?.start ?? record.source.start,
      end: unit.span?.end ?? record.source.end,
    },
    contract: {
      target: unit.contract.target,
      profile: unit.contract.profile,
      prompt_sha256: unit.contract.prompt_sha256,
      signature: unit.contract.signature,
    },
    original: {
      prompt_sha256: unit.contract.prompt_sha256,
      files: { ...record.original.files, ...promoted },
    },
    provenance: {
      origin: "generated",
      runner,
      model,
      note:
        record.provenance.origin === "adopted"
          ? `accepted attempt ${capture.attempt} (${capture.operation} ${capture.mode}); reconciled via adopt`
          : `accepted attempt ${capture.attempt} (${capture.operation} ${capture.mode})`,
    },
  };
  return new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Validate one complete candidate set in a scratch overlay through
 * the unmodified BGI-11 validator: current groups plus candidate
 * bytes plus owning sources, nothing else. Any failure preserves
 * every candidate and current file.
 */
/** Index every capture snapshot file backing the validation overlay. */
async function collectSourceSnapshots(
  root: string,
  scope: PromotionUnit[],
): Promise<Map<string, string>> {
  const sourceSnapshots = new Map<string, string>();
  for (const entry of scope) {
    const manifest = await readJsonFile(join(entry.attemptDir, SNAPSHOT_DIR, "manifest.json"));
    if (!Array.isArray(manifest)) continue; // Older capture shapes retain their existing validation behavior.
    for (const file of manifest) {
      if (!isRecord(file) || typeof file["file"] !== "string" || typeof file["stored"] !== "string") continue;
      const snapshot = resolve(entry.attemptDir, SNAPSHOT_DIR);
      const stored = resolve(snapshot, file["stored"]);
      if (relative(snapshot, stored).startsWith("..")) throw new ControlError(EXIT_INVALID, "invalid-path", "captured source leaves its snapshot");
      sourceSnapshots.set(scopeAbs(root, file["file"]), stored);
    }
  }
  return sourceSnapshots;
}

/** Copy frozen context groups and capture sources into the scratch overlay. */
async function copyValidationSources(
  root: string,
  scratch: string,
  scope: PromotionUnit[],
  sourceSnapshots: Map<string, string>,
  copied: Set<string>,
  copiedSources: Set<string>,
): Promise<void> {
  for (const entry of scope) {
    for (const unit of entry.capture.context_units ?? []) {
      if (copied.has(unit.unit_id)) continue;
      await cp(join(entry.attemptDir, SNAPSHOT_DIR, GENERATED_DIR, unit.unit_id), join(scratch, GENERATED_DIR, unit.unit_id), { recursive: true });
      copied.add(unit.unit_id);
    }
    for (const file of entry.capture.files) {
      const sourceAbs = scopeAbs(root, file);
      const sourceRel = relative(resolve(root), sourceAbs);
      if (sourceRel.length === 0 || sourceRel.startsWith("..")) continue;
      if (copiedSources.has(sourceRel)) continue;
      const bytes = await readFile(sourceSnapshots.get(sourceAbs) ?? sourceAbs);
      const revision = entry.capture.source_revisions[sourceAbs];
      if (revision !== undefined && sha256HexBytes(bytes) !== revision) throw new ControlError(EXIT_CONFLICT, "source-changed", `source ${JSON.stringify(file)} differs from its capture; recapture before validation`);
      await mkdir(dirname(join(scratch, sourceRel)), { recursive: true });
      await writeFile(join(scratch, sourceRel), bytes);
      copiedSources.add(sourceRel);
    }
  }
}

/** Materialize current groups plus candidate replacements in the overlay. */
async function applyValidationReplacements(
  root: string,
  scratch: string,
  scope: PromotionUnit[],
  copied: Set<string>,
): Promise<void> {
  for (const entry of scope) {
    const groupDir = join(root, GENERATED_DIR, entry.unit_id);
    const scratchGroup = join(scratch, GENERATED_DIR, entry.unit_id);
    if (entry.replacements.length === 0 && copied.has(entry.unit_id)) {
      // Retained Given validation consumes the frozen dependency snapshot.
    } else if (await fileExists(groupDir)) {
      await cp(groupDir, scratchGroup, { recursive: true });
    } else {
      await mkdir(scratchGroup, { recursive: true });
    }
    // Match journal publication: remove only explicitly deleted files before
    // writing additions, pruning empty parents for file/directory transitions.
    const orderedReplacements = [...entry.replacements.filter(replacement => replacement.bytes === null),
      ...entry.replacements.filter(replacement => replacement.bytes !== null)];
    for (const replacement of orderedReplacements) {
      const target = join(scratchGroup, ...replacement.path.split("/"));
      if (relative(scratchGroup, target).startsWith("..")) {
        throw new ControlError(EXIT_INVALID, "invalid-path", `replacement ${JSON.stringify(replacement.path)} escapes its unit`);
      }
      if (replacement.bytes === null) {
        await rm(target, { force: true });
        for (let parent = dirname(target); parent !== scratchGroup; parent = dirname(parent)) {
          try { await rmdir(parent); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") break;
            if (code !== "ENOENT") throw error;
          }
        }
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, replacement.bytes);
      }
    }
    copied.add(entry.unit_id);
  }
}

/** Validate every scope unit through the compiler in the scratch overlay. */
async function validateScratchUnits(
  ctx: ControlContext,
  header: RequestHeader,
  scratch: string,
  scope: PromotionUnit[],
): Promise<{ unit_id: string; fingerprint: string }[]> {
  const validated: { unit_id: string; fingerprint: string }[] = [];
  const failures: string[] = [];
  for (const entry of scope) {
    const result = await compilerRequest(ctx, {
      version: 1,
      request_id: `${header.request_id}.validate`,
      operation: "validate",
      root: scratch,
      unit_id: entry.unit_id,
    });
    if (result.code !== EXIT_OK || result.body["ok"] !== true) {
      const failure = compilerFailure("validate", result);
      failures.push(`${entry.unit_id}: [${failure.code}] ${failure.detail}`);
      continue;
    }
    const fingerprint = result.body["fingerprint"];
    validated.push({
      unit_id: entry.unit_id,
      fingerprint: typeof fingerprint === "string" ? fingerprint : "",
    });
  }
  if (failures.length > 0) {
    throw new ControlError(
      EXIT_VALIDATION,
      "validation-failure",
      `the candidate set did not validate:\n${failures.join("\n")}\nCandidates and current files are preserved.`,
      ["inspect the failures, repair or regenerate with a new request id, then resend accept"],
    );
  }
  return validated;
}

/**
 * Compile/test the frozen overlay for acceptance, never temporarily
 * replacing current outputs. Records the checked interface bytes on
 * the scope for promotion to compare.
 */
async function runAcceptanceChecks(
  ctx: ControlContext,
  header: RequestHeader,
  root: string,
  scratch: string,
  scope: PromotionUnit[],
  copied: Set<string>,
  copiedSources: Set<string>,
): Promise<void> {
  // The preparation-only Given pass above deliberately remains static: its
  // frontend siblings do not exist until the next generation job completes.
  const before = await candidateInputDigest(scratch, copiedSources);
  const checkedDeclarations: Record<string, string | null> = {};
  for (const unit of copied) {
    const path = join(scratch, GENERATED_DIR, unit, "declaration.json");
    checkedDeclarations[unit] = await fileExists(path) ? sha256HexBytes(await readFile(path)) : null;
  }
  await (ctx.appAcceptance ?? runAppAcceptance)({ root, candidateRoot: scratch,
    files: [...new Set(scope.map(entry => relative(resolve(root), scopeAbs(root, entry.record.source.path))))],
    compiler: defaultCompilerPath(), reportDir: join(root, ".can/gen/checks", runFor("run", header.request_id)),
    ...(ctx.workspace === undefined ? {} : { workspace: ctx.workspace }),
    ...(ctx.onEvent === undefined ? {} : { onEvent: ctx.onEvent }),
  });
  if (await candidateInputDigest(scratch, copiedSources) !== before) {
    throw new AppAcceptanceError("inputs", "candidate inputs changed during checks; current outputs are unchanged");
  }
  if (scope[0] !== undefined) scope[0].checkedDeclarations = checkedDeclarations;
}

async function validateCandidateSet(
  ctx: ControlContext,
  header: RequestHeader,
  root: string,
  scope: PromotionUnit[],
  acceptance = false,
): Promise<{ unit_id: string; fingerprint: string }[]> {
  await preflightSavedBindings(ctx, header, root, scope);
  await mkdir(join(root, VALIDATE_DIR), { recursive: true });
  const scratch = await mkdtemp(join(root, VALIDATE_DIR, "set-"));
  try {
    const copied = new Set<string>();
    const sourceSnapshots = await collectSourceSnapshots(root, scope);
    const copiedSources = new Set<string>();
    await copyValidationSources(root, scratch, scope, sourceSnapshots, copied, copiedSources);
    await applyValidationReplacements(root, scratch, scope, copied);
    // Every copied group, including readonly context dependencies, must
    // resolve its owner through the scratch source closure rather than live files.
    for (const unit_id of copied) {
      const recordPath = join(scratch, GENERATED_DIR, unit_id, UNIT_FILE);
      const record = parseUnitRecord(await readFile(recordPath, "utf8"), unit_id);
      const sourceAbs = scopeAbs(root, record.source.path);
      const sourceRel = relative(resolve(root), sourceAbs);
      if (sourceRel.length > 0 && !sourceRel.startsWith("..") && resolve(root, sourceRel) === sourceAbs) {
        record.source.path = sourceRel.split(sep).join("/");
        await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      }
    }
    const validated = await validateScratchUnits(ctx, header, scratch, scope);
    if (acceptance) {
      // Compile/test the frozen overlay, never temporarily replace current outputs.
      await runAcceptanceChecks(ctx, header, root, scratch, scope, copied, copiedSources);
    }
    return validated;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Tests may write reports, but must not rewrite the bytes being certified. */
async function candidateInputDigest(scratch: string, sources: Set<string>): Promise<string> {
  const files = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.set(relative(scratch, path), sha256HexBytes(await readFile(path)));
      else throw new AppAcceptanceError("inputs", "candidate files must be regular files");
    }
  }
  await walk(join(scratch, GENERATED_DIR));
  for (const source of sources) files.set(source, sha256HexBytes(await readFile(join(scratch, source))));
  return hashInput([...files].sort(([a], [b]) => a.localeCompare(b)));
}

/** Acceptance marker inside an attempt dir (explicit, never inferred). */
export const ACCEPTED_FILE = "accepted.json";

/** Refuse when an unresolved run journal overlaps the scope. */
async function assertNoOverlappingJournal(root: string, scopeIds: string[]): Promise<void> {
  for (const run of await unresolvedJournals(root)) {
    let journal: { scope: string[] };
    try {
      journal = await readJournal(root, run);
    } catch {
      continue;
    }
    const overlap = journal.scope.filter((unit) => scopeIds.includes(unit));
    if (overlap.length > 0) {
      throw new ControlError(
        EXIT_CONFLICT,
        "unresolved-journal",
        `run journal ${JSON.stringify(run)} is unresolved over ${overlap.join(", ")}; recover it before accepting`,
        ["send a lease.recover request to recover the run journal, then resend accept"],
      );
    }
  }
}

/** Collect scope write leases plus readonly context dependencies. */
async function collectPromoteLeases(
  root: string,
  scope: PromotionUnit[],
  scopeIds: string[],
): Promise<{ leasePaths: string[]; context: Map<string, CaptureUnitState> }> {
  const leasePaths: string[] = [];
  for (const entry of scope) {
    for (const unit of Object.keys(entry.checkedDeclarations ?? {})) {
      leasePaths.push(`${GENERATED_DIR}/${unit}/declaration.json`);
    }
    for (const rel of await groupFiles(root, entry.unit_id)) {
      leasePaths.push(`${GENERATED_DIR}/${entry.unit_id}/${rel}`);
    }
    if (!leasePaths.includes(`${GENERATED_DIR}/${entry.unit_id}/${UNIT_FILE}`)) {
      leasePaths.push(`${GENERATED_DIR}/${entry.unit_id}/${UNIT_FILE}`);
    }
    const sourceRel = leaseRel(root, entry.record.source.path);
    if (sourceRel !== null && !leasePaths.includes(sourceRel)) leasePaths.push(sourceRel);
    for (const replacement of entry.replacements) {
      const rel = `${GENERATED_DIR}/${entry.unit_id}/${replacement.path}`;
      if (!leasePaths.includes(rel)) leasePaths.push(rel);
    }
  }
  const context = new Map<string, CaptureUnitState>();
  for (const entry of scope) for (const unit of entry.capture.context_units ?? []) {
    if (scopeIds.includes(unit.unit_id)) continue;
    context.set(unit.unit_id, unit);
    for (const path of Object.keys(unit.current ?? {})) leasePaths.push(`${GENERATED_DIR}/${unit.unit_id}/${path}`);
  }
  return { leasePaths, context };
}

/**
 * Fence first: late, cancelled, reset, or already-accepted attempts
 * refuse before any byte comparison. Declarations reconciled before
 * validation must not change while app checks run.
 */
async function assertPromoteFences(root: string, scope: PromotionUnit[]): Promise<void> {
  for (const entry of scope) {
    for (const [unit, checked] of Object.entries(entry.checkedDeclarations ?? {})) {
      const path = join(root, GENERATED_DIR, unit, "declaration.json");
      const observed = await fileExists(path) ? sha256HexBytes(await readFile(path)) : null;
      if (observed !== checked) throw new ControlError(EXIT_CONFLICT, "interface-changed",
        `saved interface ${JSON.stringify(unit)} changed during app checks; candidates and current files are preserved`);
    }
    const live = await readFence(entry.attemptDir);
    if (live !== entry.capture.fence) {
      throw new ControlError(
        EXIT_CONFLICT,
        "attempt-fenced",
        `attempt ${JSON.stringify(entry.capture.attempt)} was fenced (${String(entry.capture.fence)} -> ${String(live)}); late results cannot promote`,
        ["inspect the fenced attempt, then retry or refine with a new request id"],
      );
    }
  }
}

/**
 * Compare the complete captured source/current closure: unit bytes,
 * semantic records, readonly context, and source revisions. Any
 * participating edit, newer acceptance, or foreign write refuses.
 */
async function assertPromoteClosure(
  root: string,
  scope: PromotionUnit[],
  context: Map<string, CaptureUnitState>,
): Promise<void> {
  // Current bytes: any participating edit, newer acceptance, or
  // foreign write since capture refuses. unit.json compares
  // semantically (association drift conflicts; adopt bookkeeping
  // is tolerated and overwritten by the promotion record), and
  // declaration.json is validated in-scratch but never compared
  // (promotion never overwrites it, so newer declarations survive).
  for (const entry of scope) {
    const unitState = entry.capture.units.find((state) => state.unit_id === entry.unit_id);
    if (unitState === undefined) {
      throw new ControlError(
        EXIT_CONFLICT,
        "current-changed",
        `unit ${JSON.stringify(entry.unit_id)} left its capture; the candidate is preserved`,
        ["diff the candidate against the newer current group, then retry or refine with a new request id"],
      );
    }
    const observed = await currentGroupMap(root, entry.unit_id);
    const mismatch = compareGroupMaps(unitState.current, observed);
    if (mismatch !== null) {
      throw new ControlError(
        EXIT_CONFLICT,
        "current-changed",
        `unit ${JSON.stringify(entry.unit_id)} changed since capture (${mismatch}); the candidate is preserved and newer work is untouched`,
        ["diff the candidate against the newer current group, then retry or refine with a new request id"],
      );
    }
    const recordMismatch = await compareRecordSemantics(root, unitState);
    if (recordMismatch !== null) {
      throw new ControlError(
        EXIT_CONFLICT,
        "association-changed",
        `unit ${JSON.stringify(entry.unit_id)} association changed since capture (${recordMismatch}); the candidate is preserved`,
        ["send a status request to inspect the unit, then bind and resend with a new request id"],
      );
    }
  }
  for (const unit of context.values()) {
    const mismatch = compareGroupMaps(unit.current, await currentGroupMap(root, unit.unit_id));
    if (mismatch !== null || await compareRecordSemantics(root, unit) !== null) {
      throw new ControlError(EXIT_CONFLICT, "context-changed", `saved dependency ${JSON.stringify(unit.unit_id)} changed since capture; candidates and current files are preserved`, ["recapture with a new request id before accepting"]);
    }
  }
  // Source revisions: any source change since capture refuses.
  for (const entry of scope) {
    for (const [file, revision] of Object.entries(entry.capture.source_revisions)) {
      let current: string;
      try {
        current = sha256HexText(await readFile(scopeAbs(root, file), "utf8"));
      } catch {
        throw new ControlError(
          EXIT_CONFLICT,
          "source-changed",
          `scope source ${JSON.stringify(file)} is unreadable; the candidate is preserved`,
          ["restore the source, then retry or refine with a new request id"],
        );
      }
      if (current !== revision) {
        throw new ControlError(
          EXIT_CONFLICT,
          "source-changed",
          `scope source ${JSON.stringify(file)} changed since capture; the candidate is preserved and newer work is untouched`,
          ["diff the candidate against the newer current group, then retry or refine with a new request id"],
        );
      }
    }
  }
}

/**
 * Stage/commit one coordinated run journal, then fence the consumed
 * attempts and mark their index entries accepted.
 */
async function commitAndFencePromotion(
  root: string,
  scope: PromotionUnit[],
  scopeIds: string[],
  runId: string,
  _reason: string,
): Promise<{ run: string; files: number }> {
  const replacements: Replacement[] = scope.flatMap((entry) => entry.replacements);
  // Submitted handles are patches; they do not declare that omitted
  // authored interfaces, helper modules or assets should disappear.
  // Rollback, by contrast, restores the complete historical membership.
  await stageJournal(root, runId, scopeIds, replacements, _reason === "rollback" ? "replace" : "patch");
  const committed = await commitJournal(root, runId);
  if (committed.kind === "conflict") {
    const files = committed.mismatches.map((entry) => `${entry.unit}:${entry.path}`).join(", ");
    throw new ControlError(
      EXIT_CONFLICT,
      "promotion-conflict",
      `promotion observed unexpected bytes at ${files}; evidence is retained at ${committed.conflictPath}`,
      ["send a lease.recover request to recover the run journal, then resend accept with a new request id"],
    );
  }
  const now = Date.now();
  const attemptDirs = [...new Set(scope.map((entry) => entry.attemptDir))];
  for (const attemptDir of attemptDirs) {
    await advanceFence(attemptDir, `accepted ${runId}`, () => now);
    const units = scope.filter((entry) => entry.attemptDir === attemptDir).map((entry) => entry.unit_id);
    await writeFile(
      join(attemptDir, ACCEPTED_FILE),
      `${JSON.stringify({ run: runId, units, at: new Date(now).toISOString() }, null, 2)}\n`,
    );
    for (const unit of units) {
      const entries = await readUnitIndex(root, unit);
      for (const index of entries.filter((candidate) => candidate.attempt === basename(attemptDir))) {
        await writeUnitIndex(root, { ...index, accepted: true });
      }
    }
  }
  return { run: runId, files: committed.files };
}

/**
 * Promote one validated scope through one coordinated run journal:
 * refuse overlapping unresolved journals, hold the scope write
 * leases, compare the complete captured source/current/fence
 * closure, stage/commit/apply, then fence the consumed attempts.
 * Conflicts preserve every candidate and current file.
 */
async function promoteSet(
  root: string,
  header: RequestHeader,
  scope: PromotionUnit[],
  runId: string,
  _reason: string,
  ctx: ControlContext,
): Promise<{ run: string; files: number }> {
  const scopeIds = [...new Set(scope.map((entry) => entry.unit_id))].sort();
  await assertNoOverlappingJournal(root, scopeIds);
  const { leasePaths, context } = await collectPromoteLeases(root, scope, scopeIds);
  const leases = await acquire(root, leasePaths, "write", `gen-accept:${header.request_id}`);
  try {
    await preflightSavedBindings(ctx, header, root, scope);
    // Fence first, then the full closure comparison.
    await assertPromoteFences(root, scope);
    await assertPromoteClosure(root, scope, context);
    return await commitAndFencePromotion(root, scope, scopeIds, runId, _reason);
  } finally {
    await release(root, leases);
  }
}

/** Files compared semantically or not at all (see promoteSet). */
const NON_STRICT_GROUP_FILES: ReadonlySet<string> = new Set(["unit.json", "declaration.json"]);

/** Compare a captured group map against the live map; null when equal. */
function compareGroupMaps(
  expected: Record<string, string> | null,
  observed: Record<string, string> | null,
): string | null {
  if (expected === null && observed === null) return null;
  if (expected === null || observed === null) return "group appeared or vanished";
  for (const [rel, sha] of Object.entries(expected)) {
    if (NON_STRICT_GROUP_FILES.has(rel)) continue;
    const seen = observed[rel];
    if (seen === undefined) return `${JSON.stringify(rel)} was removed`;
    if (seen !== sha) return `${JSON.stringify(rel)} bytes differ`;
  }
  for (const rel of Object.keys(observed)) {
    if (NON_STRICT_GROUP_FILES.has(rel)) continue;
    if (expected[rel] === undefined) return `${JSON.stringify(rel)} was added`;
  }
  return null;
}

/**
 * Compare a live unit record against its capture semantically: the
 * association key, source evidence, and contract refs must equal
 * their capture-time snapshot; provenance and original fingerprints
 * are bookkeeping the promotion record overwrites. Null when the
 * association holds.
 */
async function compareRecordSemantics(
  root: string,
  unit: CaptureUnitState,
): Promise<string | null> {
  if (unit.record_json === null) return "capture holds no record";
  let frozen: UnitRecord;
  try {
    frozen = parseUnitRecord(unit.record_json, unit.unit_id);
  } catch {
    return "capture holds no record";
  }
  let live: UnitRecord;
  try {
    live = parseUnitRecord(await readFile(join(root, GENERATED_DIR, unit.unit_id, UNIT_FILE), "utf8"), unit.unit_id);
  } catch {
    return "unit.json is unreadable";
  }
  // Provenance-only changes (adopt bookkeeping) compare equal;
  // reconciled evidence or refs refuse exactly like a rebind.
  if (live.source.owner !== frozen.source.owner) return "owner drifted";
  if (live.source.kind !== frozen.source.kind) return "kind drifted";
  if (live.source.label !== frozen.source.label) return "label drifted";
  if (live.source.anchor !== frozen.source.anchor) return "anchor drifted";
  if (live.source.selector !== frozen.source.selector || stableStringify(live.source.region) !== stableStringify(frozen.source.region)) return "local binding evidence drifted";
  if (live.source.path !== frozen.source.path) return "source path drifted";
  if (live.source.revision !== frozen.source.revision) return "source revision drifted";
  if (live.source.start !== frozen.source.start || live.source.end !== frozen.source.end) {
    return "source span drifted";
  }
  if (
    live.contract.target !== frozen.contract.target ||
    live.contract.profile !== frozen.contract.profile ||
    live.contract.prompt_sha256 !== frozen.contract.prompt_sha256 ||
    live.contract.signature !== frozen.contract.signature
  ) {
    return "contract refs drifted";
  }
  return null;
}

/**
 * `accept`: promote one unit's candidate (single-unit attempts) or
 * one attempt's complete set (multi-unit attempts accept only whole).
 */
async function runAccept(
  header: RequestHeader,
  params: AcceptParams,
  ctx: ControlContext,
): Promise<ControlResult> {
  if (params.unit_id !== undefined) {
    return acceptUnit(header, params.root, params.unit_id, ctx);
  }
  return acceptAttempt(header, params.root, params.attempt as string, ctx);
}

/** Newest attempt holding a complete candidate set for one unit. */
async function newestCompleteForUnit(
  root: string,
  unit_id: string,
): Promise<ScannedAttempt | null> {
  const attempts = await scanAttempts(root);
  const ranked = attempts
    .filter((attempt) => attempt.capture !== null)
    .sort((a, b) =>
      (a.capture as CaptureRecord).captured_at < (b.capture as CaptureRecord).captured_at ? 1 : -1,
    );
  for (const attempt of ranked) {
    const capture = attempt.capture as CaptureRecord;
    if (!capture.units.some((state) => state.unit_id === unit_id)) continue;
    if (await attemptComplete(capture, attempt.dir, unit_id)) return attempt;
  }
  return null;
}

async function acceptUnit(
  header: RequestHeader,
  root: string,
  unit_id: string,
  ctx: ControlContext,
): Promise<ControlResult> {
  await requireRecord(root, unit_id);
  const attempt = await newestCompleteForUnit(root, unit_id);
  if (attempt === null || attempt.capture === null) {
    throw new ControlError(
      EXIT_VALIDATION,
      "incomplete-set",
      `unit ${JSON.stringify(unit_id)} has no complete candidate set; current files are preserved`,
      ["inspect the unit's attempts, then retry or refine with a new request id"],
    );
  }
  if (attempt.capture.units.length > 1) {
    throw new ControlError(
      EXIT_INVALID,
      "full-set-required",
      `attempt ${JSON.stringify(attempt.capture.attempt)} holds a multi-unit candidate set; accept the attempt scope together`,
      [`send an accept request with attempt ${JSON.stringify(attempt.capture.attempt)}`],
    );
  }
  if ((attempt.capture.parent_set?.attempts.length ?? 0) > 1) {
    throw new ControlError(
      EXIT_INVALID,
      "full-set-required",
      `unit ${JSON.stringify(unit_id)} belongs to parent set ${JSON.stringify(attempt.capture.parent_set?.request_id ?? "")}; accept the attempt scope together`,
      [`send an accept request with attempt ${JSON.stringify(attempt.capture.attempt)}`],
    );
  }
  const scope = await promotionScopeFromAttempts(root, [attempt.dir]);
  await validateCandidateSet(ctx, header, root, scope, true);
  const promoted = await promoteSet(root, header, scope, runFor("run", header.request_id), "accept unit", ctx);
  return {
    code: EXIT_OK,
    envelope: okEnvelope(
      header,
      "accepted",
      {
        run: promoted.run,
        files: promoted.files,
        units: [unit_id],
        attempt: attempt.capture.attempt,
        qualified: true,
      },
      ["rebuild from the promoted saved groups with zero AI"],
    ),
  };
}

/**
 * Resolve the acceptance set for one captured attempt: the attempt
 * alone when it carries no parent set, otherwise every sibling
 * attempt the parent request planned. Missing or foreign siblings
 * refuse (a partial set never promotes); the scope builder then
 * requires every sibling's outputs and checks through one journal.
 */
async function resolveAcceptSet(
  root: string,
  raw: CaptureRecord,
  attemptDir: string,
): Promise<{ dirs: string[]; attempts: string[] }> {
  const set = raw.parent_set;
  if (set === undefined || set.attempts.length <= 1) {
    return { dirs: [attemptDir], attempts: [raw.attempt] };
  }
  if (
    typeof set.request_id !== "string" ||
    set.request_id.length === 0 ||
    !Array.isArray(set.attempts) ||
    set.attempts.some((name) => typeof name !== "string")
  ) {
    throw new ControlError(
      EXIT_INVALID,
      "unknown-attempt",
      `attempt ${JSON.stringify(raw.attempt)} carries a malformed parent set; acceptance refuses`,
      ["inspect the attempt, then retry or refine with a new request id"],
    );
  }
  const dirs: string[] = [];
  for (const name of set.attempts) {
    if (!safeEntry(name)) {
      throw new ControlError(EXIT_INVALID, "unknown-attempt", `parent set names ${JSON.stringify(name)}, which is not an attempt id`, [
        "inspect the attempt, then retry or refine with a new request id",
      ]);
    }
    const dir = join(root, ATTEMPTS_DIR, name);
    const sibling = await readJsonFile(join(dir, CAPTURE_FILE));
    if (!isCaptureRecord(sibling)) {
      throw new ControlError(
        EXIT_VALIDATION,
        "incomplete-set",
        `attempt ${JSON.stringify(raw.attempt)} belongs to parent set ${JSON.stringify(set.request_id)}, whose sibling ${JSON.stringify(name)} has no capture; current files are preserved`,
        ["inspect the incomplete attempts, then retry or refine with a new request id"],
      );
    }
    const siblingRequest = sibling.parent_set?.request_id ?? sibling.request_id;
    if (siblingRequest !== set.request_id) {
      throw new ControlError(
        EXIT_CONFLICT,
        "attempt-fenced",
        `parent set ${JSON.stringify(set.request_id)} changed under attempt ${JSON.stringify(raw.attempt)} (sibling ${JSON.stringify(name)} belongs to ${JSON.stringify(siblingRequest)}); the candidate is preserved`,
        ["inspect the attempts, then retry or refine with a new request id"],
      );
    }
    dirs.push(dir);
  }
  return { dirs, attempts: [...set.attempts] };
}

async function acceptAttempt(
  header: RequestHeader,
  root: string,
  attemptName: string,
  ctx: ControlContext,
): Promise<ControlResult> {
  if (!safeEntry(attemptName)) {
    throw new ControlError(EXIT_INVALID, "invalid-param", `attempt ${JSON.stringify(attemptName)} is not an attempt id`);
  }
  const attemptDir = join(root, ATTEMPTS_DIR, attemptName);
  const raw = await readJsonFile(join(attemptDir, CAPTURE_FILE));
  if (!isCaptureRecord(raw)) {
    throw new ControlError(EXIT_INVALID, "unknown-attempt", `no captured attempt ${JSON.stringify(attemptName)}`, [
      "send a status request to list attempts with candidates",
    ]);
  }
  const set = await resolveAcceptSet(root, raw, attemptDir);
  const scope = await promotionScopeFromAttempts(root, set.dirs);
  await validateCandidateSet(ctx, header, root, scope, true);
  const promoted = await promoteSet(root, header, scope, runFor("run", header.request_id), "accept attempt", ctx);
  return {
    code: EXIT_OK,
    envelope: okEnvelope(
      header,
      "accepted",
      {
        run: promoted.run,
        files: promoted.files,
        units: scope.map((entry) => entry.unit_id),
        attempt: raw.attempt,
        attempts: set.attempts,
        qualified: true,
      },
      ["rebuild from the promoted saved groups with zero AI"],
    ),
  };
}

/**
 * `adopt`: deterministic adoption of directly repaired files. The
 * repaired files validate through the BGI-11 files scope (no AI),
 * then the unit record refreshes to the live source association
 * with adopted provenance. Compatible direct edits never need this;
 * only source/interface drift does.
 */
async function runAdopt(
  header: RequestHeader,
  params: AdoptParams,
  ctx: ControlContext,
): Promise<ControlResult> {
  const root = params.root;
  const record = await requireRecord(root, params.unit_id);
  const repairedFiles: string[] = [];
  for (const file of params.files) {
    const rel = leaseRel(root, file);
    const prefix = `${GENERATED_DIR}/${params.unit_id}/`;
    if (rel === null || (!rel.startsWith(prefix) && rel !== `${GENERATED_DIR}/${params.unit_id}/${UNIT_FILE}`)) {
      throw new ControlError(
        EXIT_INVALID,
        "invalid-param",
        `adopt file ${JSON.stringify(file)} is outside unit ${JSON.stringify(params.unit_id)}'s saved group`,
        ["adopt only the unit's own repaired saved files"],
      );
    }
    repairedFiles.push(rel);
  }
  const leasePaths = [`${GENERATED_DIR}/${params.unit_id}/${UNIT_FILE}`];
  const sourceRel = leaseRel(root, record.source.path);
  if (sourceRel !== null) leasePaths.push(sourceRel);
  const leases = await acquire(root, leasePaths, "write", `gen-adopt:${header.request_id}`);
  try {
    const validated = await compilerRequest(ctx, {
      version: 1,
      request_id: `${header.request_id}.validate`,
      operation: "validate",
      root,
      // Saved validation binds these canonical paths under the explicit root;
      // absolute source operands belong to status/inspect/bind only.
      files: repairedFiles,
    });
    if (validated.code !== EXIT_OK || validated.body["ok"] !== true) {
      throw compilerFailure("validate", validated);
    }
    const status = await compilerStatus(ctx, header.request_id, root, [record.source.path]);
    assertResolvableStatus(status);
    const entry = status.find((candidate) => candidate.id === params.unit_id && candidate.association === "retained");
    if (entry === undefined || entry.contract === null) {
      throw new ControlError(
        EXIT_INVALID,
        "source-drifted",
        `saved unit ${JSON.stringify(params.unit_id)} matches no live source unit; reconcile with an explicit bind`,
        ["send a status request to inspect the unit, then bind and resend adopt"],
      );
    }
    let revision: string;
    try {
      revision = sha256HexText(await readFile(scopeAbs(root, record.source.path), "utf8"));
    } catch {
      throw new ControlError(EXIT_INVALID, "unreadable-input", `owning source ${JSON.stringify(record.source.path)} does not open for reading`, [
        "restore the owning source, or send a bind request to reconcile the unit",
      ]);
    }
    const now = ctx.now ?? Date.now;
    const next: UnitRecord = {
      abi_version: record.abi_version,
      id: record.id,
      source: {
        ...record.source,
        revision,
        start: entry.span?.start ?? record.source.start,
        end: entry.span?.end ?? record.source.end,
      },
      contract: {
        target: entry.contract.target,
        profile: entry.contract.profile,
        prompt_sha256: entry.contract.prompt_sha256,
        signature: entry.contract.signature,
      },
      original: record.original,
      provenance: {
        origin: "adopted",
        runner: null,
        model: null,
        note: `adopted repaired files at ${new Date(now()).toISOString()}`,
      },
    };
    await writeFile(
      join(root, GENERATED_DIR, params.unit_id, UNIT_FILE),
      `${JSON.stringify(next, null, 2)}\n`,
    );
    return {
      code: EXIT_OK,
      envelope: okEnvelope(
        header,
        "adopted",
        { unit_id: params.unit_id, files: params.files, prompt_changed: entry.prompt_changed ?? true },
        ["rebuild from the adopted saved group with zero AI"],
      ),
    };
  } finally {
    await release(root, leases);
  }
}

/**
 * Refuse when the recorded capture no longer matches live sources
 * or unit intents. Source revisions refuse before the compiler is
 * consulted; prompt/contract drift refuses after.
 */
async function assertResumeCaptureApplicable(
  ctx: ControlContext,
  header: RequestHeader,
  root: string,
  capture: CaptureRecord,
): Promise<void> {
  for (const [file, revision] of Object.entries(capture.source_revisions)) {
    let current: string;
    try {
      current = sha256HexText(await readFile(scopeAbs(root, file), "utf8"));
    } catch {
      throw new ControlError(
        EXIT_CONFLICT,
        "capture-changed",
        "the current capture no longer matches the recording; resume refuses and explicit new work is required",
        ["start explicit new work with a new request id"],
      );
    }
    if (current !== revision) {
      throw new ControlError(
        EXIT_CONFLICT,
        "capture-changed",
        "the current capture no longer matches the recording; resume refuses and explicit new work is required",
        ["start explicit new work with a new request id"],
      );
    }
  }
  const status = await compilerStatus(ctx, header.request_id, root, capture.files);
  assertResolvableStatus(status);
  const live = new Map(status.filter((entry) => entry.id !== null).map((entry) => [entry.id as string, entry]));
  for (const unit of capture.units) {
    const entry = live.get(unit.unit_id);
    if (
      entry === undefined ||
      entry.prompt !== unit.prompt ||
      entry.contract === null ||
      entry.contract.prompt_sha256 !== unit.contract.prompt_sha256 ||
      entry.contract.target !== unit.contract.target ||
      entry.contract.profile !== unit.contract.profile ||
      entry.contract.signature !== unit.contract.signature
    ) {
      throw new ControlError(
        EXIT_CONFLICT,
        "capture-changed",
        "the current capture no longer matches the recording; resume refuses and explicit new work is required",
        ["start explicit new work with a new request id"],
      );
    }
  }
}

/**
 * `resume`: continue a specific recorded runner session when the
 * adapter supports it and the capture is still applicable. Changed
 * captures, fenced attempts, and unrecorded sessions refuse.
 */
async function runResume(
  header: RequestHeader,
  params: ResumeParams,
  ctx: ControlContext,
): Promise<ControlResult> {
  const now = ctx.now ?? Date.now;
  const attempts = await scanAttempts(params.root);
  const recorded = attempts.find((attempt) => attempt.record?.session === params.session_id) ?? null;
  if (recorded === null || recorded.capture === null) {
    throw new ControlError(EXIT_INVALID, "unknown-session", `no recorded session ${JSON.stringify(params.session_id)}`, [
      "send a status request to list attempts with candidates",
    ]);
  }
  const capture = recorded.capture;
  // Applicability first, locally, then unit intents through the compiler.
  await assertResumeCaptureApplicable(ctx, header, params.root, capture);
  const attempt = `${attemptFor(header.request_id, 0)}.rs`;
  const attemptDir = join(params.root, ATTEMPTS_DIR, attempt);
  const allowed: AllowedTarget[] = Object.entries(capture.handles).map(([handle, issued]) => ({
    handle,
    role: issued.role as McpRole,
    kind: capture.units.find((state) => state.unit_id === issued.unit)?.kind ?? "view",
    filename: issued.filename,
  }));
  const required = Object.entries(capture.handles)
    .filter(([, issued]) => issued.required)
    .map(([handle]) => handle);
  const byId = new Map(capture.units.map((unit) => [unit.unit_id, unit]));
  const prompt = [
    `# Resumed generation run (continues recorded session ${params.session_id})`,
    "",
    ...capture.units.flatMap((unit) => [
      `## Unit ${unit.unit_id} (${unit.kind})`,
      `Contract: target=${unit.contract.target ?? "-"} profile=${unit.contract.profile ?? "-"} signature=${unit.contract.signature ?? "-"}`,
      `Prompt: ${unit.prompt}`,
      "",
    ]),
    ...(capture.instruction === null ? [] : ["## Instruction", capture.instruction, ""]),
    "Submit every required output through generation_submit; host placement is final.",
  ].join("\n");
  void byId;
  const outcome = await resumeSession({
    request_id: `${header.request_id}.resume`,
    input: { operation: "resume", session: params.session_id, capture: capture.source_digest },
    recordedAttemptDir: recorded.dir,
    capture_digest: capture.source_digest,
    prompt,
    attemptDir,
    stateDir: join(params.root, ".can/gen"),
    coordinationRoot: params.root,
    assertCurrent: () => withControlClaim(ctx, async () => {}),
    allowed,
    required,
    mcpBridge: ctx.mcpBridge === undefined ? defaultMcpBridge() : ctx.mcpBridge,
    now,
    ...(ctx.codexHome === undefined ? {} : { codexHome: ctx.codexHome }),
    ...(ctx.profileName === undefined ? {} : { profileName: ctx.profileName }),
    ...(ctx.preflight === undefined ? {} : { preflight: ctx.preflight }),
    ...(ctx.resolveExecutable === undefined ? {} : { resolveExecutable: ctx.resolveExecutable }),
    onEvent: (phase, detail) => ctx.onEvent?.(`resume-${phase}`, detail),
    ...(ctx.onSession === undefined ? {} : { onSession: ctx.onSession }),
  });
  const resumed: CaptureRecord = {
    ...capture,
    attempt,
    request_id: header.request_id,
    operation: "resume",
    captured_at: new Date(now()).toISOString(),
    fence: await readFence(attemptDir),
    resumed_from: recorded.name,
    history: [...capture.history, { op: "resume", detail: `resumed from ${recorded.name}`, at: new Date(now()).toISOString() }],
  };
  await writeFile(join(attemptDir, CAPTURE_FILE), `${JSON.stringify(resumed, null, 2)}\n`);
  const inventory = await readCandidateInventory(join(attemptDir, CANDIDATES_DIR));
  for (const unit of resumed.units) {
    const handles = Object.entries(resumed.handles)
      .filter(([, issued]) => issued.unit === unit.unit_id)
      .map(([handle]) => handle);
    await writeUnitIndex(params.root, {
      attempt,
      unit: unit.unit_id,
      captured_at: resumed.captured_at,
      complete: missingHandles(resumed, inventory, unit.unit_id).length === 0,
      accepted: false,
      handles,
    });
  }
  const complete = missingHandles(resumed, inventory, null).length === 0;
  return {
    code: outcome.exit,
    envelope:
      outcome.exit === EXIT_OK
        ? okEnvelope(
            header,
            outcome.state,
            {
              attempt,
              session: outcome.session,
              resumed_from: recorded.name,
              submission_complete: outcome.submission_complete,
              disk_complete: complete,
              qualified: outcome.qualified,
              tries: outcome.tries,
              detail: outcome.detail,
            },
            complete ? ["validate the candidate set, then accept it"] : ["inspect the resumed attempt"],
          )
        : resultEnvelope(
            header,
            false,
            outcome.state,
            {
              attempt,
              session: outcome.session,
              resumed_from: recorded.name,
              submission_complete: outcome.submission_complete,
              disk_complete: complete,
              qualified: outcome.qualified,
              tries: outcome.tries,
              error: { code: outcome.state === "unknown" ? "unknown-completion" : "runner-failure", message: outcome.detail },
            },
            ["inspect the resumed attempt, then resend corrected work with a new request id"],
          ),
  };
}

/**
 * `rollback`: restore an explicitly selected historical revision
 * with compatibility checking. `previous` restores the retained
 * group; `git:<rev>` materializes the unit's group from source
 * control. Both validate through the scratch overlay and promote
 * through the same run-journal protocol as acceptance.
 */
async function runRollback(
  header: RequestHeader,
  params: RollbackParams,
  ctx: ControlContext,
): Promise<ControlResult> {
  const root = params.root;
  const record = await requireRecord(root, params.unit_id);
  const now = ctx.now ?? Date.now;
  const replacements =
    params.revision === "previous"
      ? await previousReplacements(root, params.unit_id)
      : await gitReplacements(root, params.unit_id, params.revision, ctx.git ?? defaultGitRunner);
  // Rollback carries no capture: synthesize a scope whose closure is
  // the live group itself, so any concurrent change still refuses.
  const live = await currentGroupMap(root, params.unit_id);
  if (live === null) {
    throw new ControlError(EXIT_INVALID, "unknown-unit", `no saved unit ${JSON.stringify(params.unit_id)} under ${root}`, [
      "send a status request to list saved units",
    ]);
  }
  // Restore absence as well as bytes. Keeping a newer helper or asset
  // would make rollback a patch rather than the requested old group.
  const restored = new Set(replacements.map(replacement => replacement.path));
  for (const path of Object.keys(live)) if (!restored.has(path)) {
    replacements.push({ unit: params.unit_id, path, bytes: null });
  }
  const attemptDir = join(root, ATTEMPTS_DIR, attemptFor(header.request_id, 0));
  await mkdir(attemptDir, { recursive: true });
  let sourceRevision: string | null = null;
  try {
    sourceRevision = sha256HexText(await readFile(scopeAbs(root, record.source.path), "utf8"));
  } catch {
    sourceRevision = null;
  }
  const capture: CaptureRecord = {
    version: 1,
    attempt: attemptFor(header.request_id, 0),
    request_id: header.request_id,
    operation: "rollback",
    mode: "rollback",
    root,
    files: [record.source.path],
    app_id: root,
    source_digest: "",
    captured_at: new Date(now()).toISOString(),
    fence: await readFence(attemptDir),
    source_revisions: sourceRevision === null ? {} : { [record.source.path]: sourceRevision },
    units: [
      {
        unit_id: params.unit_id,
        kind: record.source.kind,
        category: categoryFor(record.source.kind),
        agent: record.contract.profile,
        prompt: "",
        contract: {
          target: record.contract.target,
          profile: record.contract.profile,
          prompt_sha256: record.contract.prompt_sha256,
          signature: record.contract.signature,
        },
        prompt_changed: false,
        current: live,
        span: { start: record.source.start, end: record.source.end },
        job: 0,
        owner: record.source.owner,
        label: record.source.label,
        path: record.source.path,
        record_json: await readRecordText(root, params.unit_id),
      },
    ],
    handles: {},
    recipes: [],
    instruction: null,
    resumed_from: null,
    unleased: [],
    history: [],
  };
  const scope: PromotionUnit[] = [
    { unit_id: params.unit_id, record, capture, attemptDir, replacements, origins: replacements.map(() => null) },
  ];
  await validateCandidateSet(ctx, header, root, scope, true);
  const promoted = await promoteSet(root, header, scope, runFor("rollback", header.request_id), "rollback", ctx);
  return {
    code: EXIT_OK,
    envelope: okEnvelope(
      header,
      "rolled-back",
      { run: promoted.run, files: promoted.files, units: [params.unit_id], revision: params.revision, qualified: true },
      ["rebuild from the restored saved group with zero AI"],
    ),
  };
}

/** Read the retained previous group as rollback replacements. */
async function previousReplacements(root: string, unit_id: string): Promise<Replacement[]> {
  const previousDir = join(root, ".can/gen/previous", unit_id);
  const collected = await collectDirBytes(previousDir);
  if (collected.length === 0) {
    throw new ControlError(EXIT_INVALID, "no-previous", `unit ${JSON.stringify(unit_id)} retains no previous group`, [
      "roll back to a source-control revision with git:<rev> instead",
    ]);
  }
  return collected.map(({ rel, bytes }) => ({ unit: unit_id, path: rel, bytes }));
}

/** Collect every regular file under a dir as unit-relative replacements. */
async function collectDirBytes(dir: string): Promise<{ rel: string; bytes: Uint8Array }[]> {
  const out: { rel: string; bytes: Uint8Array }[] = [];
  async function walk(current: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw error;
    }
    for (const name of names.sort()) {
      if (!safeEntry(name)) continue;
      const full = join(current, name);
      const info = await stat(full).catch(() => null);
      if (info === null || !info.isFile()) {
        if (info !== null && info.isDirectory()) await walk(full);
        continue;
      }
      const rel = relative(dir, full).split(sep).join("/");
      try {
        validateRel(rel);
      } catch {
        continue;
      }
      out.push({ rel, bytes: new Uint8Array(await readFile(full)) });
    }
  }
  await walk(dir);
  return out;
}

/** Materialize a unit's group at a source-control revision. */
async function gitReplacements(
  root: string,
  unit_id: string,
  revision: string,
  git: GitRunner,
): Promise<Replacement[]> {
  const match = /^git:(.+)$/.exec(revision);
  if (match === null || (match[1] as string).trim().length === 0) {
    throw new ControlError(
      EXIT_INVALID,
      "invalid-param",
      `rollback revision ${JSON.stringify(revision)} selects "previous" or "git:<rev>"`,
      ['roll back to "previous" or a git:<rev> source-control revision'],
    );
  }
  const rev = match[1] as string;
  if (rev.includes("\0")) {
    throw new ControlError(EXIT_INVALID, "invalid-param", "the git revision carries a NUL byte");
  }
  const prefix = `${GENERATED_DIR}/${unit_id}`;
  let listed: Awaited<ReturnType<GitRunner>>;
  try {
    listed = await git(["ls-tree", "-r", "--name-only", "-z", rev, "--", prefix], { cwd: root });
  } catch (error) {
    throw new ControlError(EXIT_INVALID, "git-unavailable", `cannot run git: ${error instanceof Error ? error.message : String(error)}`, [
      "install git or roll back to the retained previous group",
    ]);
  }
  if (listed.code !== 0) {
    throw new ControlError(
      EXIT_INVALID,
      "unknown-revision",
      `cannot list ${JSON.stringify(prefix)} at revision ${JSON.stringify(rev)}: ${listed.stderr.slice(0, 300)}`,
      ["pass an existing source-control revision and resend"],
    );
  }
  const listing = typeof listed.stdout === "string" ? listed.stdout : Buffer.from(listed.stdout).toString("utf8");
  const paths = listing.split("\0").filter((entry) => entry.length > 0 && entry.startsWith(`${prefix}/`));
  if (paths.length === 0) {
    throw new ControlError(
      EXIT_INVALID,
      "unknown-revision",
      `revision ${JSON.stringify(rev)} holds no ${JSON.stringify(prefix)} group`,
      ["pass a revision carrying the unit's saved group and resend"],
    );
  }
  const replacements: Replacement[] = [];
  for (const path of paths.sort()) {
    const rel = path.slice(prefix.length + 1);
    try {
      validateRel(rel);
    } catch {
      continue;
    }
    let shown: Awaited<ReturnType<GitRunner>>;
    try {
      shown = await git(["show", `${rev}:${path}`], { cwd: root });
    } catch (error) {
      throw new ControlError(EXIT_INVALID, "git-unavailable", `cannot run git: ${error instanceof Error ? error.message : String(error)}`, [
        "install git or roll back to the retained previous group",
      ]);
    }
    if (shown.code !== 0) {
      throw new ControlError(
        EXIT_INVALID,
        "unknown-revision",
        `cannot read ${JSON.stringify(path)} at revision ${JSON.stringify(rev)}: ${shown.stderr.slice(0, 300)}`,
        ["pass an existing source-control revision and resend"],
      );
    }
    replacements.push({ unit: unit_id, path: rel, bytes: typeof shown.stdout === "string" ? new TextEncoder().encode(shown.stdout) : shown.stdout });
  }
  return replacements;
}

/**
 * `cancel`: stop execution best-effort and fence the attempt so
 * late results cannot promote. Cancelling a completed attempt
 * fences it against late acceptance; candidates stay inspectable.
 */
async function runCancel(
  header: RequestHeader,
  params: CancelParams,
  ctx: ControlContext,
): Promise<ControlResult> {
  const attempts = await scanAttempts(params.root);
  const matched =
    params.session_id !== undefined
      ? attempts.filter((attempt) => attempt.record?.session === params.session_id)
      : attempts.filter(
          (attempt) =>
            attempt.record?.request_id === params.request || attempt.capture?.request_id === params.request,
        );
  if (matched.length === 0) {
    const selector = params.session_id !== undefined ? `session ${JSON.stringify(params.session_id)}` : `request ${JSON.stringify(params.request)}`;
    throw new ControlError(EXIT_INVALID, "unknown-session", `no attempt matches ${selector}`, [
      "send a status request to list attempts with candidates",
    ]);
  }
  const now = ctx.now ?? Date.now;
  const fenced: string[] = [];
  for (const attempt of matched) {
    const fence = await cancelAttempt({
      attemptDir: attempt.dir,
      ...(ctx.registry === undefined ? {} : { registry: ctx.registry }),
      ...(attempt.record?.attempt === undefined ? {} : { registryKey: attempt.record.attempt }),
      now,
    });
    fenced.push(`${attempt.name} (fence ${String(fence)})`);
    if (attempt.capture !== null) {
      await markControlSuperseded(params.root, attempt.capture.request_id);
    }
  }
  return {
    code: EXIT_OK,
    envelope: okEnvelope(
      header,
      "cancelled",
      { attempts: fenced, detail: "late results from the fenced attempts cannot promote" },
      ["inspect the fenced attempts, then start explicit new work with a new request id"],
    ),
  };
}

/**
 * `reset`: discard selected pending work while preserving current
 * files and direct edits. Single-unit scopes reset their attempt
 * fully; resetting one unit out of a multi-unit attempt explicitly
 * rescopes the attempt to its remaining units.
 */
async function runReset(
  header: RequestHeader,
  params: ResetParams,
  ctx: ControlContext,
): Promise<ControlResult> {
  const now = ctx.now ?? Date.now;
  if (params.unit_id !== undefined) {
    return resetUnit(params.root, header, params.unit_id, ctx, now);
  }
  const attempts = await scanAttempts(params.root);
  const matched =
    params.attempt !== undefined
      ? attempts.filter((attempt) => attempt.name === params.attempt)
      : attempts.filter((attempt) => attempt.record?.session === params.session_id);
  if (matched.length === 0) {
    throw new ControlError(EXIT_INVALID, "unknown-session", "no attempt matches the reset selector", [
      "send a status request to list attempts with candidates",
    ]);
  }
  const fenced: string[] = [];
  for (const attempt of matched) {
    if (attempt.capture !== null) await markControlSuperseded(params.root, attempt.capture.request_id);
    const fence = await resetAttempt({ attemptDir: attempt.dir, stateDir: join(params.root, ".can/gen"), coordinationRoot: params.root, now });
    fenced.push(`${attempt.name} (fence ${String(fence)})`);
    if (attempt.capture !== null) {
      for (const unit of attempt.capture.units) {
        await removeUnitIndex(params.root, unit.unit_id, attempt.name);
      }
    }
  }
  return {
    code: EXIT_OK,
    envelope: okEnvelope(
      header,
      "reset",
      { attempts: fenced, detail: "pending work is discarded; current files and direct edits are preserved" },
      ["start explicit new work with a new request id"],
    ),
  };
}

async function resetUnit(
  root: string,
  header: RequestHeader,
  unit_id: string,
  _ctx: ControlContext,
  now: () => number,
): Promise<ControlResult> {
  await requireRecord(root, unit_id);
  const attempts = await scanAttempts(root);
  const holding = attempts.filter(
    (attempt) => attempt.capture !== null && attempt.capture.units.some((state) => state.unit_id === unit_id),
  );
  if (holding.length === 0) {
    throw new ControlError(EXIT_INVALID, "unknown-unit", `unit ${JSON.stringify(unit_id)} holds no pending work`, [
      "send a status request to list attempts with candidates",
    ]);
  }
  const details: string[] = [];
  for (const attempt of holding) {
    const capture = attempt.capture as CaptureRecord;
    if (capture.units.length === 1) {
      await markControlSuperseded(root, capture.request_id);
      const fence = await resetAttempt({ attemptDir: attempt.dir, stateDir: join(root, ".can/gen"), coordinationRoot: root, now });
      details.push(`${attempt.name}: attempt reset (fence ${String(fence)})`);
      await removeUnitIndex(root, unit_id, attempt.name);
      continue;
    }
    // Explicit rescope: the unit's handles leave the attempt, its
    // candidate bytes are removed, and the capture digest covers
    // the remaining units. The remaining set still accepts whole.
    const handles = Object.entries(capture.handles).filter(([, issued]) => issued.unit === unit_id);
    for (const [handle] of handles) {
      await rm(join(attempt.dir, CANDIDATES_DIR, handle), { recursive: true, force: true });
    }
    const discarded = await readDiscarded(attempt.dir);
    const at = new Date(now()).toISOString();
    for (const [handle] of handles) {
      discarded.discarded.push({ handle, unit: unit_id, at, reason: `reset unit ${unit_id}` });
    }
    if (!discarded.rescoped_units.includes(unit_id)) discarded.rescoped_units.push(unit_id);
    await writeDiscarded(attempt.dir, discarded);
    const remaining = capture.units.filter((state) => state.unit_id !== unit_id);
    const remainingHandles = Object.fromEntries(
      Object.entries(capture.handles).filter(([, issued]) => issued.unit !== unit_id),
    );
    const rescoped: CaptureRecord = {
      ...capture,
      units: remaining,
      handles: remainingHandles,
      source_digest: scopeDigest(
        root,
        capture.files,
        capture.source_revisions,
        remaining.map((state) => ({
          unit_id: state.unit_id,
          kind: state.kind,
          prompt: state.prompt,
          contract: state.contract,
        })),
      ),
      history: [...capture.history, { op: "rescope-remove", detail: `reset removed unit ${unit_id}`, at }],
    };
    await writeFile(join(attempt.dir, CAPTURE_FILE), `${JSON.stringify(rescoped, null, 2)}\n`);
    await removeUnitIndex(root, unit_id, attempt.name);
    await markControlSuperseded(root, capture.request_id);
    details.push(`${attempt.name}: rescoped to ${remaining.map((state) => state.unit_id).join(",")}`);
  }
  return {
    code: EXIT_OK,
    envelope: okEnvelope(
      header,
      "reset",
      { unit_id, attempts: details, detail: "pending work is discarded; current files and direct edits are preserved" },
      ["start explicit new work with a new request id"],
    ),
  };
}

/**
 * `edit.begin`: acquire brief write leases over exact unit/source
 * paths and return the token. The authoring agent then edits those
 * files normally; the lease is coordination, not approval.
 */
async function runEditBegin(
  header: RequestHeader,
  params: EditBeginParams,
  _ctx: ControlContext,
): Promise<ControlResult> {
  const root = params.root;
  const paths: string[] = [];
  if (params.unit_id !== undefined) {
    const record = await requireRecord(root, params.unit_id);
    for (const rel of await groupFiles(root, params.unit_id)) {
      paths.push(`${GENERATED_DIR}/${params.unit_id}/${rel}`);
    }
    const unitRel = `${GENERATED_DIR}/${params.unit_id}/${UNIT_FILE}`;
    if (!paths.includes(unitRel)) paths.push(unitRel);
    const sourceRel = leaseRel(root, record.source.path);
    if (sourceRel !== null) paths.push(sourceRel);
  }
  if (params.paths !== undefined) {
    for (const path of params.paths) {
      const rel = leaseRel(root, path);
      if (rel === null) {
        throw new ControlError(EXIT_INVALID, "invalid-param", `edit path ${JSON.stringify(path)} stays inside the request root`);
      }
      if (!(await fileExists(join(root, rel)))) {
        throw new ControlError(EXIT_INVALID, "unreadable-input", `edit path ${JSON.stringify(path)} does not open for reading`, [
          "pass existing editable paths and resend",
        ]);
      }
      if (!paths.includes(rel)) paths.push(rel);
    }
  }
  const set = await acquire(root, paths, "write", `gen-edit:${header.request_id}`);
  return {
    code: EXIT_OK,
    envelope: okEnvelope(
      header,
      "editing",
      { token: set.token, paths: set.paths, holder: set.holder },
      ["edit the listed paths normally, then release with edit.end"],
    ),
  };
}

/** Release one lock file when it carries the edit token; null when it does not. */
async function releaseEditLockEntry(
  root: string,
  name: string,
  token: string,
): Promise<{ rel: string; mode: string; holder: string } | null> {
  if (!safeEntry(name) || !name.endsWith(".lock")) return null;
  const parsed = await readJsonFile(join(root, LOCKS_DIR, name));
  if (!isRecord(parsed)) return null;
  if (parsed["token"] !== token) return null;
  const rel = typeof parsed["path"] === "string" ? (parsed["path"] as string) : null;
  const mode = parsed["mode"] === "read" || parsed["mode"] === "write" ? (parsed["mode"] as string) : null;
  const holder = typeof parsed["holder"] === "string" ? (parsed["holder"] as string) : null;
  if (rel === null || mode === null || holder === null) return null;
  await release(root, { holder, token, mode: mode as "read" | "write", paths: [rel] });
  return { rel, mode, holder };
}

/**
 * `edit.end`: release every lock held under one token. Unknown
 * tokens refuse; the releasing request id supersedes so a resend
 * of the matching `edit.begin` starts fresh.
 */
async function runEditEnd(
  header: RequestHeader,
  params: EditEndParams,
  _ctx: ControlContext,
): Promise<ControlResult> {
  const root = params.root;
  let token: string;
  try {
    token = parseToken(params.token);
  } catch (error) {
    if (error instanceof LeaseError) {
      throw new ControlError(EXIT_INVALID, error.code, error.message.replace(/^lease: /, ""), [
        "pass the token returned by edit.begin",
      ]);
    }
    throw error;
  }
  let names: string[];
  try {
    names = await readdir(join(root, LOCKS_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new ControlError(EXIT_INVALID, "unknown-token", "the token holds no lease", [
        "pass the token returned by an open edit.begin",
      ]);
    }
    throw error;
  }
  const released: { rel: string; mode: string; holder: string }[] = [];
  for (const name of names.sort()) {
    const entry = await releaseEditLockEntry(root, name, token);
    if (entry !== null) released.push(entry);
  }
  if (released.length === 0) {
    throw new ControlError(EXIT_INVALID, "unknown-token", "the token holds no lease", [
      "pass the token returned by an open edit.begin",
    ]);
  }
  for (const entry of released) {
    const match = /^gen-edit:(.+)$/.exec(entry.holder);
    if (match !== null) {
      await markControlSuperseded(root, match[1] as string);
    }
  }
  released.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return {
    code: EXIT_OK,
    envelope: okEnvelope(header, "released", { token, paths: released.map((entry) => entry.rel) }, [
      "the paths are editable by other writers again",
    ]),
  };
}

/**
 * `lease.recover`: recover an interrupted writer's lease (the
 * request itself confirms the writer has stopped) and recover
 * every unresolved run journal under coordinated write leases.
 * Staged journals restore the whole old set; committed journals
 * finish the whole new set; unexpected bytes stay retained.
 */
async function runLeaseRecover(
  header: RequestHeader,
  params: LeaseRecoverParams,
  _ctx: ControlContext,
): Promise<ControlResult> {
  const root = params.root;
  const at = params.lease.lastIndexOf("@");
  const holder = at === -1 ? "" : params.lease.slice(0, at);
  const tokenText = at === -1 ? "" : params.lease.slice(at + 1);
  if (holder.length === 0 || tokenText.length === 0) {
    throw new ControlError(
      EXIT_INVALID,
      "invalid-param",
      `lease ${JSON.stringify(params.lease)} selects "holder@token"`,
      ["pass the interrupted lease as holder@token"],
    );
  }
  let token: string;
  try {
    token = parseToken(tokenText);
  } catch (error) {
    if (error instanceof LeaseError) {
      throw new ControlError(EXIT_INVALID, error.code, error.message.replace(/^lease: /, ""), [
        "pass the interrupted lease as holder@token",
      ]);
    }
    throw error;
  }
  const recovered = await recoverStoppedWriter(root, holder, token, true);
  const unresolved = await unresolvedJournals(root);
  if (recovered.length === 0 && unresolved.length === 0) {
    throw new ControlError(EXIT_INVALID, "unknown-lease", `lease ${JSON.stringify(params.lease)} holds nothing and no run journal is unresolved`, [
      "pass an interrupted holder@token, or resend once a journal needs recovery",
    ]);
  }
  const runs: { run: string; outcome: string; files?: number; mismatches?: unknown; conflict?: string }[] = [];
  let conflicted = false;
  for (const run of unresolved) {
    let scope: string[] = [];
    try {
      scope = (await readJournal(root, run)).scope;
    } catch {
      runs.push({ run, outcome: "unreadable" });
      conflicted = true;
      continue;
    }
    const leasePaths: string[] = [];
    for (const unit of scope) {
      for (const rel of await groupFiles(root, unit)) {
        leasePaths.push(`${GENERATED_DIR}/${unit}/${rel}`);
      }
    }
    if (leasePaths.length === 0) {
      leasePaths.push(...scope.map((unit) => `${GENERATED_DIR}/${unit}/${UNIT_FILE}`));
    }
    const leases = await acquire(root, leasePaths, "write", `gen-recover:${header.request_id}`);
    try {
      const outcome = await recoverJournal(root, run);
      if (outcome.kind === "conflict") {
        conflicted = true;
        runs.push({ run, outcome: "conflict", mismatches: outcome.mismatches, conflict: outcome.conflictPath });
      } else if (outcome.kind === "completed-new") {
        runs.push({ run, outcome: "completed-new", files: outcome.files });
      } else {
        runs.push({ run, outcome: outcome.kind });
      }
    } finally {
      await release(root, leases);
    }
  }
  const leaseNote =
    recovered.length === 0
      ? "the named lease was already gone; journals recovered"
      : `recovered lease paths: ${recovered.join(", ")}`;
  if (conflicted) {
    throw new ControlError(
      EXIT_CONFLICT,
      "recovery-conflict",
      `${leaseNote}; one or more run journals retain conflicts: ${runs
        .filter((entry) => entry.outcome === "conflict" || entry.outcome === "unreadable")
        .map((entry) => entry.run)
        .join(", ")}`,
      ["reconcile the retained conflicts, then resend lease.recover with a new request id"],
    );
  }
  return {
    code: EXIT_OK,
    envelope: okEnvelope(header, "recovered", { lease: leaseNote, runs }, [
      "resend the interrupted operation with a new request id",
    ]),
  };
}

/** Resolve a unit's candidates: newest attempt holding them, or the named one. */
async function resolveUnitCandidates(
  root: string,
  unit_id: string,
  attemptName: string | undefined,
): Promise<{ capture: CaptureRecord; attemptDir: string; inventory: CandidateSubmission[] }> {
  await requireRecord(root, unit_id);
  if (attemptName !== undefined) {
    if (!safeEntry(attemptName)) {
      throw new ControlError(EXIT_INVALID, "invalid-param", `attempt ${JSON.stringify(attemptName)} is not an attempt id`);
    }
    const attemptDir = join(root, ATTEMPTS_DIR, attemptName);
    const raw = await readJsonFile(join(attemptDir, CAPTURE_FILE));
    if (!isCaptureRecord(raw)) {
      throw new ControlError(EXIT_INVALID, "unknown-attempt", `no captured attempt ${JSON.stringify(attemptName)}`, [
        "send a status request to list attempts with candidates",
      ]);
    }
    return { capture: raw, attemptDir, inventory: await readCandidateInventory(join(attemptDir, CANDIDATES_DIR)) };
  }
  const attempts = await scanAttempts(root);
  const ranked = attempts
    .filter((attempt) => attempt.capture !== null)
    .sort((a, b) =>
      (a.capture as CaptureRecord).captured_at < (b.capture as CaptureRecord).captured_at ? 1 : -1,
    );
  for (const attempt of ranked) {
    const capture = attempt.capture as CaptureRecord;
    if (!capture.units.some((state) => state.unit_id === unit_id)) continue;
    const inventory = await readCandidateInventory(join(attempt.dir, CANDIDATES_DIR));
    if (inventory.some((entry) => capture.handles[entry.handle]?.unit === unit_id)) {
      return { capture, attemptDir: attempt.dir, inventory };
    }
  }
  throw new ControlError(EXIT_INVALID, "no-candidates", `unit ${JSON.stringify(unit_id)} holds no candidates`, [
    "send a status request to list attempts with candidates",
  ]);
}

/**
 * `diff`: machine-consumable current-vs-candidate differences for
 * one unit: per-file status, hashes, and bounded unified hunks.
 */
async function runDiff(
  header: RequestHeader,
  params: DiffParams,
  _ctx: ControlContext,
): Promise<ControlResult> {
  const root = params.root;
  const { capture, inventory } = await resolveUnitCandidates(root, params.unit_id, params.attempt);
  const intake = await readSavedGroup(root, params.unit_id);
  const current = new Map<string, { sha256: string; bytes: Uint8Array }>();
  if (intake.ok) {
    for (const file of intake.group.files) {
      current.set(file.relPath, { sha256: file.sha256, bytes: file.bytes });
    }
  }
  const candidates = new Map<string, { sha256: string; bytes: Uint8Array; handle: string }>();
  for (const entry of inventory) {
    const issued = capture.handles[entry.handle];
    if (issued === undefined || issued.unit !== params.unit_id) continue;
    try {
      const bytes = await readFile(entry.candidate);
      candidates.set(issued.saved, { sha256: sha256HexBytes(bytes), bytes: new Uint8Array(bytes), handle: entry.handle });
    } catch {
      // A recorded submission without bytes diffs as missing below.
    }
  }
  const paths = [...new Set([...current.keys(), ...candidates.keys()])].sort();
  const files: unknown[] = [];
  for (const path of paths) {
    const oldFile = current.get(path);
    const newFile = candidates.get(path);
    if (oldFile !== undefined && newFile !== undefined && oldFile.sha256 === newFile.sha256) {
      files.push({ path, status: "identical", old_sha256: oldFile.sha256, new_sha256: newFile.sha256, handle: newFile.handle });
      continue;
    }
    if (oldFile === undefined && newFile !== undefined) {
      files.push({
        path,
        status: "added",
        old_sha256: null,
        new_sha256: newFile.sha256,
        handle: newFile.handle,
        hunks: textHunks(null, newFile.bytes),
      });
      continue;
    }
    if (oldFile !== undefined && newFile === undefined) {
      files.push({ path, status: "current-only", old_sha256: oldFile.sha256, new_sha256: null, handle: null });
      continue;
    }
    if (oldFile !== undefined && newFile !== undefined) {
      files.push({
        path,
        status: "modified",
        old_sha256: oldFile.sha256,
        new_sha256: newFile.sha256,
        handle: newFile.handle,
        hunks: textHunks(oldFile.bytes, newFile.bytes),
      });
    }
  }
  return {
    code: EXIT_OK,
    envelope: okEnvelope(header, "reported", { unit_id: params.unit_id, attempt: capture.attempt, files }, [
      "accept the candidate set to promote these differences",
    ]),
  };
}

/**
 * `preview`: bounded candidate payloads for one unit. Text roles
 * preview inline; binary assets report bytes and hashes only.
 */
async function runPreview(
  header: RequestHeader,
  params: PreviewParams,
  _ctx: ControlContext,
): Promise<ControlResult> {
  const root = params.root;
  const { capture, inventory } = await resolveUnitCandidates(root, params.unit_id, undefined);
  const previews: unknown[] = [];
  for (const entry of inventory) {
    const issued = capture.handles[entry.handle];
    if (issued === undefined || issued.unit !== params.unit_id) continue;
    let bytes: Buffer | null = null;
    try {
      bytes = await readFile(entry.candidate);
    } catch {
      previews.push({ handle: entry.handle, role: entry.role, saved: issued.saved, missing: true });
      continue;
    }
    const text = bytes.toString("utf8");
    const roundTrips = Buffer.from(text, "utf8").equals(bytes);
    const cap = 4096;
    previews.push({
      handle: entry.handle,
      role: entry.role,
      filename: entry.filename,
      saved: issued.saved,
      bytes: bytes.length,
      sha256: sha256HexBytes(bytes),
      ...(roundTrips
        ? { text: text.slice(0, cap), truncated: text.length > cap }
        : { text: null, truncated: false, binary: true }),
    });
  }
  return {
    code: EXIT_OK,
    envelope: okEnvelope(header, "reported", { unit_id: params.unit_id, attempt: capture.attempt, previews }, [
      "diff the unit for current-vs-candidate hunks",
    ]),
  };
}

/** Split bytes into lines (text only; binary yields null). */
function textLines(bytes: Uint8Array): string[] | null {
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) return null;
  return text.split("\n");
}

/** Decode one hunk file pair; null when either side is binary. */
function decodeHunkLines(
  oldBytes: Uint8Array | null,
  newBytes: Uint8Array,
): { oldList: string[]; newLines: string[] } | null {
  const oldLines = oldBytes === null ? [] : textLines(oldBytes);
  const newLines = textLines(newBytes);
  if ((oldBytes !== null && oldLines === null) || newLines === null) return null;
  return { oldList: oldLines ?? [], newLines };
}

/** Extend one hunk window over near-equal ops with bounded lookahead. */
function hunkWindowEnd(ops: DiffOp[], index: number, context: number): number {
  let end = index;
  while (end < ops.length && (ops[end]?.op !== "equal" || end - index < context * 2 + 1)) {
    end += 1;
    if (ops[end]?.op === "equal") {
      let lookahead = end;
      while (lookahead < ops.length && ops[lookahead]?.op === "equal" && lookahead - end < context * 2) {
        lookahead += 1;
      }
      if (lookahead - end >= context * 2 || lookahead >= ops.length) {
        end += context;
        break;
      }
      end = lookahead;
    }
  }
  return Math.min(ops.length, end + context);
}

/** Render one hunk slice into unified lines plus its counts. */
function renderHunkSlice(
  slice: DiffOp[],
  emitted: number,
  maxLines: number,
): { oldStart: number; newStart: number; oldCount: number; newCount: number; lines: string[]; emitted: number } {
  const oldStart = (slice[0]?.oldIndex ?? 0) + 1;
  const newStart = (slice[0]?.newIndex ?? 0) + 1;
  let oldCount = 0;
  let newCount = 0;
  const lines: string[] = [];
  for (const op of slice) {
    if (emitted >= maxLines) break;
    if (op.op === "equal") {
      lines.push(` ${op.text}`);
      oldCount += 1;
      newCount += 1;
    } else if (op.op === "delete") {
      lines.push(`-${op.text}`);
      oldCount += 1;
    } else {
      lines.push(`+${op.text}`);
      newCount += 1;
    }
    emitted += 1;
  }
  return { oldStart, newStart, oldCount, newCount, lines, emitted };
}

/**
 * Bounded unified hunks for one file pair. Binary pairs report no
 * hunks; large diffs truncate with explicit flags. Line-oriented
 * Myers diff over at most a few thousand lines per side.
 */
export function textHunks(
  oldBytes: Uint8Array | null,
  newBytes: Uint8Array,
): { hunks: unknown[]; truncated: boolean; binary: boolean } {
  const decoded = decodeHunkLines(oldBytes, newBytes);
  if (decoded === null) {
    return { hunks: [], truncated: false, binary: true };
  }
  const ops = myersDiff(decoded.oldList, decoded.newLines);
  const hunks: unknown[] = [];
  const context = 3;
  const maxHunks = 50;
  const maxLines = 500;
  let emitted = 0;
  let index = 0;
  while (index < ops.length && hunks.length < maxHunks && emitted < maxLines) {
    if (ops[index]?.op === "equal") {
      index += 1;
      continue;
    }
    const start = Math.max(0, index - context);
    const end = hunkWindowEnd(ops, index, context);
    const rendered = renderHunkSlice(ops.slice(start, end), emitted, maxLines);
    emitted = rendered.emitted;
    hunks.push({ old_start: rendered.oldStart, old_lines: rendered.oldCount, new_start: rendered.newStart, new_lines: rendered.newCount, lines: rendered.lines });
    index = end;
  }
  return { hunks, truncated: index < ops.length || emitted >= maxLines, binary: false };
}

interface DiffOp {
  op: "equal" | "delete" | "insert";
  text: string;
  oldIndex: number;
  newIndex: number;
}

/** Walk one Myers trace backwards into edit operations. */
function myersBacktrack(
  oldLines: string[],
  newLines: string[],
  trace: number[][],
  offset: number,
  n: number,
  m: number,
  found: number | null,
  max: number,
): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found ?? max; d > 0; d -= 1) {
    const prev = trace[d - 1] as number[];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (prev[offset + k - 1] as number) < (prev[offset + k + 1] as number))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prev[offset + prevK] as number;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ op: "equal", text: oldLines[x] as string, oldIndex: x, newIndex: y });
    }
    if (x === prevX) {
      y -= 1;
      ops.push({ op: "insert", text: newLines[y] as string, oldIndex: x, newIndex: y });
    } else {
      x -= 1;
      ops.push({ op: "delete", text: oldLines[x] as string, oldIndex: x, newIndex: y });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    ops.push({ op: "equal", text: oldLines[x] as string, oldIndex: x, newIndex: y });
  }
  return ops.reverse();
}

/** Myers O(ND) line diff with a bounded fallback to delete-all/insert-all. */
function myersDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0) {
    return newLines.map((text, j) => ({ op: "insert" as const, text, oldIndex: 0, newIndex: j }));
  }
  if (m === 0) {
    return oldLines.map((text, i) => ({ op: "delete" as const, text, oldIndex: i, newIndex: 0 }));
  }
  if (n * m > 4_000_000) {
    return [
      ...oldLines.map((text, i) => ({ op: "delete" as const, text, oldIndex: i, newIndex: 0 })),
      ...newLines.map((text, j) => ({ op: "insert" as const, text, oldIndex: n, newIndex: j })),
    ];
  }
  const max = n + m;
  const size = 2 * max + 1;
  const offset = max;
  let v: number[] = new Array<number>(size).fill(-1);
  v[offset + 1] = 0;
  const trace: number[][] = [];
  let found: number | null = null;
  for (let d = 0; d <= max; d += 1) {
    const next = [...v];
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) {
        x = v[offset + k + 1] as number;
      } else {
        x = (v[offset + k - 1] as number) + 1;
      }
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x += 1;
        y += 1;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
    trace.push([...v]);
    if (found !== null) break;
  }
  return myersBacktrack(oldLines, newLines, trace, offset, n, m, found, max);
}




