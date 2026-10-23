/**
 * Generation lifecycle (BGI-05): recipe-grouped job planning, fresh
 * full-app retry capture, refine/fresh baselines, idempotent request
 * ledger, attempt fencing, and bounded runner execution with
 * transport/known-failure recovery.
 *
 * Manual retry derives every current prompt from the active
 * app/build closure without unit-name selectors; scoped refinement
 * keeps its declared affected scope. A repeated request id with the
 * same input recovers the recorded outcome without relaunching;
 * changed input under that id conflicts. Cancel/reset advance the
 * attempt fence before releasing coordination, so late or superseded
 * output can never promote. Outcomes always carry
 * `qualified: false`: submissions and clean runner exits report
 * completion, never acceptance (BGI-11/12 own validation/promotion).
 *
 * Real launches stay preflight-gated through BGI-03's released
 * `preflightRecipe`/`preflightResume`, which admit only qualified
 * MCP/write restrictions and independently supported resume. The injectable `preflight`/`resolveExecutable` hooks
 * exist so fake-executable tests can exercise the bounded-execution
 * mechanism; production callers leave them at their secure defaults.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { acquire, release, LeaseError } from "./leases.js";
import { persistFile } from "./journal.js";
import {
  SESSION_BINDING_FILE,
  adapterFor,
  probeExecutable,
  removeCodexMcpProfile,
  type AdapterLaunch,
  type McpBridge,
  type RunnerAdapter,
} from "./adapters.js";
import { createMcpSession, type McpSession } from "./mcp.js";
import type { EffectiveRecipe } from "./config.js";
import {
  EXIT_CONFLICT,
  EXIT_INVALID,
  EXIT_RUNNER,
  EXIT_UNKNOWN,
  handleGrammarValid,
  preflightRecipe,
  preflightResume,
  type AllowedTarget,
} from "./protocol.js";

/** Typed lifecycle failure with its process exit code. */
export class LifecycleError extends Error {
  /** Process exit code (0/2/3/4/5/6 per BGEN14). */
  readonly exit: number;
  /** Machine-readable code (`request-conflict`, ...). */
  readonly code: string;
  /** Human-actionable detail without the code prefix. */
  readonly detail: string;
  constructor(exit: number, code: string, detail: string) {
    super(`[${code}] ${detail}`);
    this.name = "LifecycleError";
    this.exit = exit;
    this.code = code;
    this.detail = detail;
  }
}

/** Default structured-result schema: a status-bearing final message. */
export const DEFAULT_OUTPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: { status: { type: "string" } },
  required: ["status"],
  additionalProperties: false,
});

/** One unit prompt inside the active app/build closure. */
export interface CaptureUnit {
  /** Opaque unit id (planning only; retry needs no selectors). */
  unit_id: string;
  /** Identity-carrying unit kind. */
  kind: string;
  /** Recipe category: Given uses shared, frontend uses Then default. */
  category: "given" | "frontend";
  /** Current static prompt text from the active closure. */
  prompt: string;
  /** Owning declaration's `agent` profile, or null for the default. */
  agent: string | null;
}

/** The active app/build dependency closure retry regenerates. */
export interface ActiveClosure {
  /** Active app id (unrelated apps are outside this closure). */
  app_id: string;
  /** Project root the closure was captured from. */
  root: string;
  /** Digest of the captured source/contract closure. */
  source_digest: string;
  /** Every current generation prompt in the closure. */
  units: CaptureUnit[];
}

/** One recipe-grouped runner job (whole-Then context for frontend). */
export interface PlannedJob {
  /** Compatible-effective-recipe grouping key. */
  key: string;
  /** Effective complete recipe for every unit in this job. */
  recipe: EffectiveRecipe;
  /** Units assigned to this job. */
  units: CaptureUnit[];
  /**
   * Context units: for frontend jobs, every Then unit in the active
   * closure (whole-Then context); otherwise the assigned units.
   */
  contextUnits: CaptureUnit[];
  /** Launch order: Given preparation precedes frontend consumers. */
  order: number;
}

/** Resolves one unit's effective recipe (BGI-12 wires resolveRecipe). */
export type RecipeResolver = (unit: CaptureUnit) => EffectiveRecipe;

/** Deterministic JSON with sorted object keys for hashing/grouping. */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}}`;
    }
    default:
      return "null";
  }
}

/** SHA-256 hex over the stable rendering of one request input. */
export function hashInput(input: unknown): string {
  return createHash("sha256").update(stableStringify(input), "utf8").digest("hex");
}

function recipeKey(recipe: EffectiveRecipe): string {
  return stableStringify({
    runner: recipe.runner,
    model: recipe.model,
    max_attempts: recipe.max_attempts,
    timeout_seconds: recipe.timeout_seconds,
    native: recipe.native,
  });
}

function checkClosure(closure: ActiveClosure): void {
  if (closure.app_id.length === 0) {
    throw new LifecycleError(EXIT_INVALID, "invalid-closure", "retry needs an active app id");
  }
  if (closure.root.length === 0) {
    throw new LifecycleError(EXIT_INVALID, "invalid-closure", "retry needs a project root");
  }
  if (closure.source_digest.length === 0) {
    throw new LifecycleError(EXIT_INVALID, "invalid-closure", "retry needs a source digest");
  }
  if (closure.units.length === 0) {
    throw new LifecycleError(EXIT_INVALID, "invalid-closure", "retry needs at least one unit prompt");
  }
  for (const unit of closure.units) {
    if (unit.unit_id.length === 0 || unit.kind.length === 0 || unit.prompt.length === 0) {
      throw new LifecycleError(
        EXIT_INVALID,
        "invalid-closure",
        "every closure unit needs a unit id, kind, and prompt",
      );
    }
    if (unit.category !== "given" && unit.category !== "frontend") {
      throw new LifecycleError(
        EXIT_INVALID,
        "invalid-closure",
        `unit ${JSON.stringify(unit.unit_id)} needs category "given" or "frontend"`,
      );
    }
    if (unit.agent !== null && unit.agent.length === 0) {
      throw new LifecycleError(
        EXIT_INVALID,
        "invalid-closure",
        `unit ${JSON.stringify(unit.unit_id)} needs a null or non-empty agent profile`,
      );
    }
  }
}

/**
 * Plan fresh full-app manual retry: every current prompt in the
 * active closure, partitioned by preparation stage (Given before
 * frontend) and then grouped by compatible effective complete
 * recipe within each stage. Given groups precede dependent
 * frontend consumers; each frontend job carries the whole Then
 * context. No unit-name selectors are consulted, and grouping
 * never implies one process per prompt: compatible units in one
 * stage still share a job.
 */
export function buildRetryJobs(closure: ActiveClosure, resolve: RecipeResolver): PlannedJob[] {
  checkClosure(closure);
  const groups = new Map<string, { recipe: EffectiveRecipe; units: CaptureUnit[] }>();
  for (const unit of closure.units) {
    const recipe = resolve(unit);
    // Preparation stage is part of the grouping key: a Given unit
    // and a frontend unit never share a job even when their
    // effective recipes are identical, so no assigned Given prompt
    // can drop out of a Then-only job context.
    const key = `${unit.category}::${recipeKey(recipe)}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { recipe, units: [unit] });
    } else {
      group.units.push(unit);
    }
  }
  const thenUnits = closure.units.filter((unit) => unit.category === "frontend");
  const jobs: PlannedJob[] = [...groups.values()].map((group) => {
    const isFrontend = group.units.some((unit) => unit.category === "frontend");
    return {
      key: recipeKey(group.recipe),
      recipe: group.recipe,
      units: [...group.units],
      contextUnits: isFrontend ? [...thenUnits] : [...group.units],
      order: 0,
    };
  });
  // Given preparation precedes dependent frontend consumers; within
  // a stage the grouping key keeps the order deterministic. Groups
  // are stage-pure, so the first unit decides the stage.
  jobs.sort((a, b) => {
    const aFrontend = a.units[0]?.category === "frontend";
    const bFrontend = b.units[0]?.category === "frontend";
    if (aFrontend !== bFrontend) return aFrontend ? 1 : -1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  jobs.forEach((job, index) => {
    job.order = index;
  });
  return jobs;
}

/** One current file captured as a refinement baseline. */
export interface CurrentFile {
  /** Host-resolved current path (read by the host, never the agent). */
  path: string;
  /** Current content, including direct edits. */
  content: string;
}

/**
 * Refine baseline: current implementation (including direct edits)
 * plus current intent/contracts and the new instruction. The
 * candidate stays separate; current files change only on acceptance.
 */
export interface RefineBaseline {
  readonly baseline: "current";
  readonly unit_id: string;
  readonly files: CurrentFile[];
  readonly intent: string;
  readonly instruction: string;
}

/** Build a refine baseline from host-read current files. */
export function buildRefineBaseline(options: {
  unit_id: string;
  files: CurrentFile[];
  intent: string;
  instruction: string;
}): RefineBaseline {
  if (options.unit_id.length === 0) {
    throw new LifecycleError(EXIT_INVALID, "invalid-baseline", "refine needs a unit id");
  }
  if (options.instruction.length === 0) {
    throw new LifecycleError(EXIT_INVALID, "invalid-baseline", "refine needs a non-empty instruction");
  }
  return {
    baseline: "current",
    unit_id: options.unit_id,
    files: options.files.map((file) => ({ ...file })),
    intent: options.intent,
    instruction: options.instruction,
  };
}

/**
 * Fresh baseline: source intent is the design baseline (current code
 * is never the design input), while the captured current group stays
 * attached for conflict/rollback protection only.
 */
export interface FreshBaseline {
  readonly baseline: "source-intent";
  readonly unit_id: string;
  readonly intent: string;
  readonly protection_snapshot: CurrentFile[];
}

/** Build a fresh baseline: intent designs, current code only protects. */
export function buildFreshBaseline(options: {
  unit_id: string;
  intent: string;
  protection_snapshot: CurrentFile[];
}): FreshBaseline {
  if (options.unit_id.length === 0) {
    throw new LifecycleError(EXIT_INVALID, "invalid-baseline", "fresh generation needs a unit id");
  }
  return {
    baseline: "source-intent",
    unit_id: options.unit_id,
    intent: options.intent,
    protection_snapshot: options.protection_snapshot.map((file) => ({ ...file })),
  };
}

/** Recorded outcome of one request id (recovered on resend). */
export interface RequestOutcome {
  /** Terminal state: candidates, failure, unknown, or cancelled. */
  state: "candidate" | "failed" | "unknown" | "cancelled";
  /** Process exit code for the recorded state. */
  exit: number;
  /** Attempt id that produced this outcome. */
  attempt: string;
  /** MCP session id that produced this outcome. */
  session: string;
  /** Attempt fence generation at completion. */
  fence: number;
  /** Human-actionable summary. */
  detail: string;
  /** Bounded next actions. */
  next: string[];
  /** Whether every required handle was submitted (never acceptance). */
  submission_complete: boolean;
  /** Always false: lifecycle outcomes never qualify or promote. */
  qualified: false;
  /** Bounded runner tries consumed. */
  tries: number;
}

/** Ledger lookup: absent, same input, superseded, or conflicting. */
export type LedgerLookup =
  | { readonly status: "absent" }
  | { readonly status: "same"; readonly outcome: RequestOutcome }
  | { readonly status: "superseded" }
  | { readonly status: "conflict" };

interface LedgerRecord {
  request_id: string;
  input_hash: string;
  superseded: boolean;
  outcome: RequestOutcome | null;
  claim?: string;
  attempt_dir?: string;
}

function ledgerFile(stateDir: string, request_id: string): string {
  // Caller request ids are never path-interpolated raw.
  const safe = handleGrammarValid(request_id) ? request_id : `id-${hashInput(request_id)}`;
  return join(stateDir, "requests", `${safe}.json`);
}

/** Look up one request id against the recorded input hash. */
export async function lookupRequest(
  stateDir: string,
  request_id: string,
  inputHash: string,
): Promise<LedgerLookup> {
  let text: string;
  try {
    text = await readFile(ledgerFile(stateDir, request_id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "absent" };
    throw error;
  }
  let record: LedgerRecord;
  try {
    record = JSON.parse(text) as LedgerRecord;
  } catch {
    throw new LifecycleError(
      EXIT_UNKNOWN,
      "ledger-unreadable",
      `request ${JSON.stringify(request_id)} has an unreadable ledger record; recover explicitly`,
    );
  }
  if (record === null || typeof record !== "object" || record.request_id !== request_id || typeof record.input_hash !== "string" || typeof record.superseded !== "boolean") {
    throw new LifecycleError(
      EXIT_UNKNOWN,
      "ledger-unreadable",
      `request ${JSON.stringify(request_id)} has an unreadable ledger record; recover explicitly`,
    );
  }
  if (record.superseded) return { status: "superseded" };
  if (record.input_hash !== inputHash) return { status: "conflict" };
  if (record.outcome === null) throw new LifecycleError(EXIT_UNKNOWN, "request-in-flight",
    `request ${JSON.stringify(request_id)} has no terminal outcome; inspect its recorded attempt before explicit recovery`);
  const outcome = record.outcome;
  if (outcome === undefined || typeof outcome !== "object"
      || !["candidate", "failed", "unknown", "cancelled"].includes(outcome.state)
      || !Number.isSafeInteger(outcome.exit) || !Number.isSafeInteger(outcome.fence) || outcome.fence < 0
      || typeof outcome.attempt !== "string" || typeof outcome.session !== "string"
      || typeof outcome.detail !== "string" || !Array.isArray(outcome.next) || outcome.next.some(item => typeof item !== "string")
      || typeof outcome.submission_complete !== "boolean" || outcome.qualified !== false
      || !Number.isSafeInteger(outcome.tries) || outcome.tries < 0) {
    throw new LifecycleError(EXIT_UNKNOWN, "ledger-unreadable", "Request has an unreadable recorded outcome; inspect it before explicit recovery.");
  }
  return { status: "same", outcome };
}

/** Request metadata uses the existing cooperative leases for short updates.
 * The durable pending outcome survives the process; no lease is held by a runner. */
export async function withRequestLedger<T>(root: string, path: string, action: () => Promise<T>): Promise<T> {
  let lease;
  try {
    lease = await acquire(root, [relative(root, path).split(sep).join("/")], "write", "gen-request-ledger");
  } catch (error) {
    if (error instanceof LeaseError && error.code === "conflict") {
      throw new LifecycleError(EXIT_UNKNOWN, "request-in-flight", "Request ledger is being updated; inspect or resend this same request without starting new work.");
    }
    throw error;
  }
  try { return await action(); } finally { await release(root, lease); }
}

export async function persistRequestRecord(path: string, record: unknown): Promise<void> {
  await persistFile(path, Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
}

/** Publish only the outcome of the still-current durable claim. */
export async function storeRequest(
  stateDir: string, request_id: string, inputHash: string, outcome: RequestOutcome,
  claim?: string, coordinationRoot = stateDir,
): Promise<void> {
  const path = ledgerFile(stateDir, request_id);
  await withRequestLedger(coordinationRoot, path, async () => {
    let attempt_dir: string | undefined;
    if (claim !== undefined) {
      const current = JSON.parse(await readFile(path, "utf8")) as LedgerRecord;
      attempt_dir = current.attempt_dir;
      if (current.superseded || current.claim !== claim || current.input_hash !== inputHash) {
        throw new LifecycleError(EXIT_CONFLICT, "request-superseded", "The request claim changed; its old execution cannot publish a new outcome.");
      }
    }
    await persistRequestRecord(path, { request_id, input_hash: inputHash, superseded: false, outcome,
      ...(claim === undefined ? {} : { claim }), ...(attempt_dir === undefined ? {} : { attempt_dir }) });
  });
}

/** Explicit stopped/fenced recovery permits a new claim; an old owner retains
 * its old token and cannot publish over that replacement. */
export async function markSuperseded(stateDir: string, request_id: string, coordinationRoot = stateDir): Promise<void> {
  const path = ledgerFile(stateDir, request_id);
  await withRequestLedger(coordinationRoot, path, async () => {
    let record: LedgerRecord;
    try { record = JSON.parse(await readFile(path, "utf8")) as LedgerRecord; }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      record = { request_id, input_hash: "", superseded: true, outcome: null };
    }
    if (record.request_id !== request_id) throw new LifecycleError(EXIT_UNKNOWN, "ledger-unreadable", "Request ledger identity differs.");
    await persistRequestRecord(path, { ...record, superseded: true });
  });
}

async function claimJobRequest(options: Pick<ExecuteJobOptions, "stateDir" | "request_id" | "attemptDir" | "coordinationRoot">,
  inputHash: string, kind: "run" | "resume"): Promise<{ claim: string; fence: number } | { outcome: RequestOutcome }> {
  return withRequestLedger(options.coordinationRoot ?? options.stateDir, ledgerFile(options.stateDir, options.request_id), async () => {
    const lookup = await lookupRequest(options.stateDir, options.request_id, inputHash);
    if (lookup.status === "same") return { outcome: lookup.outcome };
    if (lookup.status === "conflict") throw new LifecycleError(EXIT_CONFLICT, "request-conflict", "Request id carries changed input; use a new id for new work.");
    const fence = await readFence(options.attemptDir), claim = randomUUID();
    const outcome: RequestOutcome = {
      state: "unknown", exit: EXIT_UNKNOWN, attempt: `${options.request_id}.g${String(fence)}.${kind}`,
      session: `${options.request_id}.g${String(fence)}.s`, fence,
      detail: "Request is durably bound to this attempt; it may be running or interrupted. Resending cannot launch it again.",
      next: [`inspect the attempt at ${options.attemptDir}`, "wait for its outcome or explicitly recover a stopped, fenced attempt"],
      submission_complete: false, qualified: false, tries: 0,
    };
    await persistRequestRecord(ledgerFile(options.stateDir, options.request_id), {
      request_id: options.request_id, input_hash: inputHash, superseded: false, outcome, claim, attempt_dir: resolve(options.attemptDir),
    });
    return { claim, fence };
  });
}

async function withJobClaim<T>(options: Pick<ExecuteJobOptions, "stateDir" | "request_id" | "coordinationRoot">,
  claim: string, action: () => Promise<T>): Promise<T> {
  const path = ledgerFile(options.stateDir, options.request_id);
  return withRequestLedger(options.coordinationRoot ?? options.stateDir, path, async () => {
    const current = JSON.parse(await readFile(path, "utf8")) as LedgerRecord;
    if (current.superseded || current.claim !== claim) {
      throw new LifecycleError(EXIT_CONFLICT, "request-superseded", "Old execution no longer owns this request or its attempt metadata.");
    }
    return action();
  });
}

/** Persisted attempt fence: cancel/reset/resume move it forward. */
export interface AttemptFence {
  generation: number;
  reason: string;
  at: string;
}

/** Read the attempt fence generation (missing files are generation 0). */
export async function readFence(attemptDir: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(join(attemptDir, "fence.json"), "utf8")) as AttemptFence;
    return typeof parsed.generation === "number" ? parsed.generation : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    throw error;
  }
}

/** Advance the attempt fence, recording why coordination moved on. */
export async function advanceFence(
  attemptDir: string,
  reason: string,
  now: () => number = Date.now,
): Promise<number> {
  const generation = (await readFence(attemptDir)) + 1;
  const fence: AttemptFence = { generation, reason, at: new Date(now()).toISOString() };
  await mkdir(attemptDir, { recursive: true });
  await writeFile(join(attemptDir, "fence.json"), `${JSON.stringify(fence, null, 2)}\n`);
  return generation;
}

/** Persisted attempt record: identity, capture, runner session, pid. */
export interface AttemptRecord {
  attempt: string;
  session: string;
  request_id: string;
  capture_digest: string;
  snapshotDir: string;
  recipe: EffectiveRecipe;
  fence: number;
  runner_session: string | null;
  pid: number | null;
  resumed_from: string | null;
  state: string;
}

async function writeAttempt(attemptDir: string, record: AttemptRecord): Promise<void> {
  await mkdir(attemptDir, { recursive: true });
  await writeFile(join(attemptDir, "attempt.json"), `${JSON.stringify(record, null, 2)}\n`);
}

/** Read one recorded attempt (unknown sessions refuse explicitly). */
export async function readAttempt(attemptDir: string): Promise<AttemptRecord> {
  let text: string;
  try {
    text = await readFile(join(attemptDir, "attempt.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new LifecycleError(
        EXIT_INVALID,
        "unknown-session",
        `no recorded attempt at ${JSON.stringify(attemptDir)}`,
      );
    }
    throw error;
  }
  return JSON.parse(text) as AttemptRecord;
}

/** Host-written MCP session binding (no secrets, no physical paths). */
export interface SessionBinding {
  session: string;
  attempt: string;
  source_digest: string;
  fence: number;
  allowed: number;
  created_at: string;
}

/** In-process registry of live run controllers, keyed by attempt. */
export type RunRegistry = Map<string, AbortController>;

/**
 * Native authentication home: explicit CODEX_HOME wins, otherwise
 * ~/.codex. The Codex adapter isolates housekeeping under each attempt
 * and links native auth without reading or copying credential bytes.
 */
export function defaultCodexHome(): string {
  const env = process.env["CODEX_HOME"];
  if (env !== undefined && env.length > 0) return env;
  return join(homedir(), ".codex");
}

/** Progress phases emitted while a bounded job runs. */
export type JobPhase = "planned" | "recovered" | "launched" | "retry" | "completed";

/** Execute one bounded runner job. */
export interface ExecuteJobOptions {
  /** Caller request id (idempotency key). */
  request_id: string;
  /** Canonical request input (hashed for the ledger). */
  input: unknown;
  /** Effective complete recipe for this job. */
  recipe: EffectiveRecipe;
  /** Digest of the captured source/contract closure. */
  source_digest: string;
  /** Permitted output targets from the checked descriptors. */
  allowed: AllowedTarget[];
  /** Full agent prompt (whole-Then context rendered by the caller). */
  prompt: string;
  /** Captured read-only snapshot the agent works from. */
  snapshotDir: string;
  /** Host-owned attempt scratch (binding, schema, candidates). */
  attemptDir: string;
  /** Host-owned ledger root for request idempotency. */
  stateDir: string;
  /** Existing lease root for request metadata (defaults to stateDir). */
  coordinationRoot?: string;
  /** Additional owning-control check; never replaces the lifecycle permission gates. */
  assertCurrent?: () => Promise<void>;
  /** JSON Schema text for the structured final message. */
  outputSchema?: string;
  /** Required handles (defaults to every allowed handle). */
  required?: readonly string[];
  /**
   * MCP stdio bridge attached to the launch (the production
   * `defaultMcpBridge()` serves the attempt's live session).
   * Explicit null attaches no transport: the fake/test path, where
   * submissions arrive through `onSession` instead.
   */
  mcpBridge?: McpBridge | null;
  /** Codex home for the bounded per-attempt profile layer (default: `defaultCodexHome()`). */
  codexHome?: string;
  /** Per-attempt profile name. */
  profileName?: string;
  /** Cancel signal (lifecycle kills and fences on abort). */
  signal?: AbortSignal;
  /** Registry receiving this run's controller for cancel(). */
  registry?: RunRegistry;
  /** Registry key for this run (defaults to the attempt id). */
  registryKey?: string;
  /** Clock for stamps (tests inject a fixed clock). */
  now?: () => number;
  /** Launch gate (default: BGI-03 preflight; overrides are test-only). */
  preflight?: (recipe: EffectiveRecipe) => void;
  /** Executable resolver (default: PATH probe; fakes inject a path). */
  resolveExecutable?: (binaries: readonly string[]) => Promise<string>;
  /** Progress callback (BGI-12 maps phases to JSONL events). */
  onEvent?: (phase: JobPhase, detail: string) => void;
  /** Session hook: tests submit through the live MCP session here; production submissions arrive over the bridge. */
  onSession?: (session: McpSession) => void;
}

/** Best-effort recorded runner session id from `--json` JSONL output. */
export function extractRunnerSession(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    for (const key of ["thread_id", "session_id", "threadId", "sessionId"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return null;
}

const MAX_TIMER_MS = 2147483647;
const OUTPUT_CAP_BYTES = 262144;
const KILL_GRACE_MS = 5000;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

interface SpawnCapture {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  runnerSession: string | null;
  pid: number | null;
  spawnError?: string;
}

/**
 * Run one bounded child: argv array, no shell, attempt scratch cwd,
 * prompt on stdin, finite timeout, bounded output capture. Timeout
 * kills escalate SIGTERM to SIGKILL after a bounded grace; a fired
 * timeout always reports unknown completion, never success.
 */
async function spawnBounded(
  launch: AdapterLaunch,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  recordPid: (pid: number | null) => void,
): Promise<SpawnCapture> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(launch.file, launch.args, {
      cwd: launch.cwd,
      env: launch.inheritEnv === false ? launch.env : { ...process.env, ...launch.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      timeout: 0,
    });
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      timedOut: false,
      cancelled: false,
      runnerSession: null,
      pid: null,
    };
  }
  recordPid(child.pid ?? null);
  let stdout = "";
  let stderr = "";
  let stdoutCapped = false;
  let stderrCapped = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdoutCapped) return;
    stdout += chunk.toString("utf8");
    if (stdout.length > OUTPUT_CAP_BYTES) {
      stdout = stdout.slice(0, OUTPUT_CAP_BYTES);
      stdoutCapped = true;
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrCapped) return;
    stderr += chunk.toString("utf8");
    if (stderr.length > OUTPUT_CAP_BYTES) {
      stderr = stderr.slice(0, OUTPUT_CAP_BYTES);
      stderrCapped = true;
    }
  });
  try {
    child.stdin?.write(launch.stdin);
    child.stdin?.end();
  } catch {
    // The child may exit before reading its prompt; its exit decides.
  }
  let timedOut = false;
  let cancelled = false;
  let finished = false;
  const killEscalated = async (): Promise<void> => {
    if (finished) return;
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    await sleepMs(KILL_GRACE_MS);
    if (finished) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // The process is already gone; its exit decides.
    }
  };
  const onAbort = (): void => {
    cancelled = true;
    void killEscalated();
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  let spawnError: string | undefined;
  const exit = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    child.on("error", (cause: unknown) => {
      // Missing/denied binaries surface here; `close` still fires
      // and carries the terminal state alongside this cause.
      spawnError = cause instanceof Error ? cause.message : String(cause);
    });
    child.on("close", (code, killSignal) => {
      finished = true;
      resolve({ exitCode: code, signal: killSignal });
    });
  });
  // Cancellable chained watchdog: a natural exit disarms the timer
  // immediately instead of waiting out the remaining timeout, while
  // huge finite timeouts still schedule correctly past the platform
  // timer ceiling.
  let watchdog: NodeJS.Timeout | undefined;
  const arm = (remaining: number): void => {
    if (finished || remaining <= 0) return;
    watchdog = setTimeout(() => {
      if (finished) return;
      const next = remaining - Math.min(remaining, MAX_TIMER_MS);
      if (next <= 0) {
        timedOut = true;
        void killEscalated();
      } else {
        arm(next);
      }
    }, Math.min(remaining, MAX_TIMER_MS));
    watchdog.unref?.();
  };
  arm(timeoutMs);
  const result = await exit;
  if (watchdog !== undefined) clearTimeout(watchdog);
  if (signal !== undefined) signal.removeEventListener("abort", onAbort);
  if (stdoutCapped) stdout += "\n…(stdout truncated)…";
  if (stderrCapped) stderr += "\n…(stderr truncated)…";
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout,
    stderr,
    timedOut,
    cancelled: cancelled && !timedOut,
    runnerSession: extractRunnerSession(stdout),
    pid: child.pid ?? null,
    ...(spawnError === undefined ? {} : { spawnError }),
  };
}

interface FileMode {
  path: string;
  mode: number;
}

async function collectModes(root: string, out: FileMode[]): Promise<void> {
  const info = await stat(root);
  out.push({ path: root, mode: info.mode });
  if (!info.isDirectory()) return;
  for (const entry of await readdir(root)) {
    const full = join(root, entry);
    const child = await stat(full).catch(() => null);
    if (child === null) continue;
    if (child.isDirectory()) {
      await collectModes(full, out);
    } else {
      out.push({ path: full, mode: child.mode });
    }
  }
}

/**
 * Run `task` with every write bit removed from the snapshot tree,
 * restoring exact recorded modes afterwards. The captured project
 * is read-only to the generator at the OS level; current and
 * candidate roots are never inside the snapshot and no context
 * given to the agent names their paths.
 */
export async function withReadOnlySnapshot<T>(snapshotDir: string, task: () => Promise<T>): Promise<T> {
  const modes: FileMode[] = [];
  await collectModes(snapshotDir, modes);
  for (const entry of modes) {
    try {
      await chmod(entry.path, entry.mode & ~0o222);
    } catch {
      // Best-effort hardening: a file the host cannot chmod is left
      // as-is and the run still proceeds under adapter flags.
    }
  }
  try {
    return await task();
  } finally {
    for (const entry of modes) {
      try {
        await chmod(entry.path, entry.mode);
      } catch {
        // Restoration is best-effort; the captured bytes never change.
      }
    }
  }
}

function checkExecuteOptions(options: ExecuteJobOptions): void {
  if (options.request_id.length === 0) {
    throw new LifecycleError(EXIT_INVALID, "invalid-request", "execution needs a request id");
  }
  if (options.source_digest.length === 0) {
    throw new LifecycleError(EXIT_INVALID, "invalid-request", "execution needs a source digest");
  }
  if (options.prompt.length === 0) {
    throw new LifecycleError(EXIT_INVALID, "invalid-request", "execution needs a non-empty prompt");
  }
  if (options.snapshotDir.length === 0 || options.attemptDir.length === 0 || options.stateDir.length === 0) {
    throw new LifecycleError(EXIT_INVALID, "invalid-request", "execution needs snapshot, attempt, and state dirs");
  }
}

interface TryOutcome {
  capture: SpawnCapture;
  parsed: ReturnType<RunnerAdapter["parseResult"]>;
}

/**
 * Execute one bounded runner job: ledger idempotency, pre-launch
 * preflight, host-owned MCP session, read-only snapshot, finite
 * tries with bounded auto-retry of known failures only. Unknown
 * completion and cancellation never auto-repeat; every terminal
 * outcome is recorded under the request id for resend recovery.
 */
export async function executeJob(options: ExecuteJobOptions): Promise<RequestOutcome> {
  checkExecuteOptions(options);
  const now = options.now ?? Date.now;
  const emit = options.onEvent ?? ((): void => {});
  const inputHash = hashInput(options.input);
  const lookup = await lookupRequest(options.stateDir, options.request_id, inputHash);
  if (lookup.status === "same") {
    emit("recovered", `request ${JSON.stringify(options.request_id)} recovers its recorded outcome; no relaunch`);
    return lookup.outcome;
  }
  if (lookup.status === "conflict") {
    throw new LifecycleError(
      EXIT_CONFLICT,
      "request-conflict",
      `request ${JSON.stringify(options.request_id)} carries changed input; a new id is required for new work`,
    );
  }
  // Preflight gates before any attempt artifact exists: unsupported
  // MCP transport or write enforcement refuses without side effects.
  const preflight = options.preflight ?? preflightRecipe;
  preflight(options.recipe);
  await options.assertCurrent?.();
  const reservation = await claimJobRequest(options, inputHash, "run");
  if ("outcome" in reservation) return reservation.outcome;
  const adapter = adapterFor(options.recipe.runner);
  const resolveExecutable = options.resolveExecutable ?? probeExecutable;
  const executable = await resolveExecutable(adapter.probeBinaries()).catch((error: unknown) => {
    if (error instanceof Error) return { failed: error.message };
    return { failed: String(error) };
  });
  if (typeof executable !== "string") {
    const detail = executable.failed;
    const outcome: RequestOutcome = {
      state: "failed",
      exit: EXIT_RUNNER,
      attempt: options.request_id,
      session: options.request_id,
      fence: 0,
      detail,
      next: ["run doctor for the selected runner", "resend with a working executable"],
      submission_complete: false,
      qualified: false,
      tries: 0,
    };
    await storeRequest(options.stateDir, options.request_id, inputHash, outcome, reservation.claim, options.coordinationRoot);
    return outcome;
  }

  await options.assertCurrent?.();
  const fence = reservation.fence;
  if (await readFence(options.attemptDir) !== fence) throw new LifecycleError(EXIT_CONFLICT, "session-superseded", "Attempt was fenced after request admission.");
  const attempt = `${options.request_id}.g${String(fence)}.run`;
  const sessionId = `${options.request_id}.g${String(fence)}.s`;
  const candidateRoot = join(options.attemptDir, "candidates");
  const session = await createMcpSession({
    session: sessionId,
    attempt,
    source_digest: options.source_digest,
    allowed: options.allowed,
    instructions: options.prompt,
    candidateRoot,
    ...(options.required === undefined ? {} : { required: options.required }),
    now,
  });
  options.onSession?.(session);
  const sessionFile = join(options.attemptDir, SESSION_BINDING_FILE);
  const binding: SessionBinding = {
    session: sessionId,
    attempt,
    source_digest: options.source_digest,
    fence,
    allowed: options.allowed.length,
    created_at: new Date(now()).toISOString(),
  };
  await withJobClaim(options, reservation.claim, () => writeFile(sessionFile, `${JSON.stringify(binding, null, 2)}\n`));
  const record: AttemptRecord = {
    attempt,
    session: sessionId,
    request_id: options.request_id,
    capture_digest: options.source_digest,
    snapshotDir: options.snapshotDir,
    recipe: options.recipe,
    fence,
    runner_session: null,
    pid: null,
    resumed_from: null,
    state: "running",
  };
  await withJobClaim(options, reservation.claim, () => writeAttempt(options.attemptDir, record));

  const controller = new AbortController();
  const registryKey = options.registryKey ?? attempt;
  if (options.registry !== undefined) options.registry.set(registryKey, controller);
  const combined = anyAborted(options.signal, controller.signal);
  const timeoutMs = options.recipe.timeout_seconds * 1000;
  const launch: AdapterLaunch = await adapter.buildLaunch({
    recipe: options.recipe,
    snapshotDir: options.snapshotDir,
    attemptDir: options.attemptDir,
    sessionFile,
    prompt: options.prompt,
    outputSchema: options.outputSchema ?? DEFAULT_OUTPUT_SCHEMA,
    mcpBridge: options.mcpBridge ?? null,
    codexHome: options.codexHome ?? defaultCodexHome(),
    profileName: options.profileName ?? `can-gen-${attempt}`,
  });
  launch.file = executable;
  emit("planned", `attempt ${JSON.stringify(attempt)} launches ${executable} with ${String(options.allowed.length)} allowed targets`);
  let outcome: RequestOutcome;
  try {
    outcome = await withReadOnlySnapshot(options.snapshotDir, async () => {
      const tries: TryOutcome[] = [];
      for (let tryNo = 1; tryNo <= options.recipe.max_attempts; tryNo += 1) {
        if (combined.aborted) break;
        const attemptLaunch: AdapterLaunch =
          tryNo === 1
            ? launch
            : {
                ...launch,
                stdin: `${launch.stdin}\n\n[bounded retry ${String(tryNo)}/${String(options.recipe.max_attempts)}: already submitted: ${submittedList(session)}; still required: ${remainingList(session)}]`,
              };
        await options.assertCurrent?.();
        await withJobClaim(options, reservation.claim, async () => {
          if (await readFence(options.attemptDir) !== fence) throw new LifecycleError(EXIT_CONFLICT, "session-superseded", "Attempt changed before launch.");
        });
        emit(tryNo === 1 ? "launched" : "retry", `attempt ${JSON.stringify(attempt)} try ${String(tryNo)}`);
        // The pid is recorded while the child runs so cancel controls
        // can signal the live process; the write is awaited below.
        let pidWrite: Promise<void> | null = null;
        let pidFailure: unknown;
        const capture = await spawnBounded(attemptLaunch, timeoutMs, combined, (pid) => {
          record.pid = pid;
          pidWrite = withJobClaim(options, reservation.claim, () => writeAttempt(options.attemptDir, record))
            .catch(error => { pidFailure = error; controller.abort(); });
        });
        if (pidWrite !== null) await pidWrite;
        if (pidFailure !== undefined) throw pidFailure;
        if (capture.runnerSession !== null) record.runner_session = capture.runnerSession;
        await withJobClaim(options, reservation.claim, () => writeAttempt(options.attemptDir, record));
        const parsed = adapter.parseResult({
          exitCode: capture.exitCode,
          signal: capture.signal,
          stdout: capture.stdout,
          stderr: capture.stderr,
          timedOut: capture.timedOut,
          ...(capture.spawnError === undefined ? {} : { spawnError: capture.spawnError }),
        });
        tries.push({ capture, parsed });
        if (capture.cancelled || combined.aborted) break;
        if (parsed.kind === "ok") break;
        if (parsed.kind === "unknown") break;
        if (!parsed.retryable) break;
      }
      return finishTries(options, attempt, sessionId, fence, tries, combined.aborted, session);
    });
  } finally {
    if (options.registry !== undefined) options.registry.delete(registryKey);
    for (const file of launch.cleanupFiles) {
      await removeCodexMcpProfile(file);
    }
  }
  if (outcome.state === "cancelled") {
    // The run observed its own abort: fence the attempt and its
    // session here so cancellation always fences before releasing
    // coordination, whichever path triggered the abort. Fences are
    // monotonic generations, so a racing cancel control advancing
    // the same fence twice stays correct.
    const fenced = await advanceFence(options.attemptDir, "cancel", now);
    session.supersede("cancel");
    outcome = { ...outcome, fence: fenced };
  }
  record.state = outcome.state;
  record.pid = null;
  await withJobClaim(options, reservation.claim, () => writeAttempt(options.attemptDir, record));
  await storeRequest(options.stateDir, options.request_id, inputHash, outcome, reservation.claim, options.coordinationRoot);
  emit("completed", `attempt ${JSON.stringify(attempt)} ${outcome.state}: ${outcome.detail}`);
  return outcome;
}

function submittedList(session: McpSession): string {
  const submitted = session.completion().submitted;
  return submitted.length === 0 ? "(none)" : submitted.join(",");
}

function remainingList(session: McpSession): string {
  const remaining = session.completion().remaining;
  return remaining.length === 0
    ? "(none; every required output is submitted, so exit 0 without resubmitting when they stand)"
    : remaining.join(",");
}

/** Merge two abort signals (caller cancel plus registry cancel). */
function anyAborted(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  if (first === undefined) return second;
  if (first.aborted || second.aborted) return AbortSignal.abort();
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  first.addEventListener("abort", onAbort, { once: true });
  second.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

function finishTries(
  options: ExecuteJobOptions,
  attempt: string,
  sessionId: string,
  fence: number,
  tries: TryOutcome[],
  aborted: boolean,
  session: McpSession,
): RequestOutcome {
  const last = tries[tries.length - 1];
  // Completion comes from the live MCP session, never from the
  // tries alone; a clean exit with missing outputs stays incomplete.
  const submission_complete = session.completion().complete;
  if (aborted || (last !== undefined && last.capture.cancelled)) {
    return {
      state: "cancelled",
      exit: EXIT_RUNNER,
      attempt,
      session: sessionId,
      fence,
      detail: "run cancelled; the attempt fence advanced and late output cannot promote",
      next: [`inspect the fenced attempt at ${options.attemptDir}`, "start explicit new work with a new request id"],
      submission_complete,
      qualified: false,
      tries: tries.length,
    };
  }
  if (last === undefined) {
    return {
      state: "failed",
      exit: EXIT_RUNNER,
      attempt,
      session: sessionId,
      fence,
      detail: "run ended before any bounded try launched",
      next: ["resend with a new request id"],
      submission_complete,
      qualified: false,
      tries: 0,
    };
  }
  if (last.parsed.kind === "unknown") {
    return {
      state: "unknown",
      exit: EXIT_UNKNOWN,
      attempt,
      session: sessionId,
      fence,
      detail: last.parsed.detail,
      next: [
        `recover by session ${sessionId} when the adapter supports it`,
        "or start an explicit new attempt acknowledging possible duplicate work and cost",
      ],
      submission_complete,
      qualified: false,
      tries: tries.length,
    };
  }
  if (last.parsed.kind === "known-failure") {
    const exhausted = tries.length >= options.recipe.max_attempts || !last.parsed.retryable;
    return {
      state: "failed",
      exit: EXIT_RUNNER,
      attempt,
      session: sessionId,
      fence,
      detail: exhausted
        ? `runner failed after ${String(tries.length)} bounded try/tries: ${last.parsed.detail}`
        : last.parsed.detail,
      next: [
        `inspect the attempt at ${options.attemptDir}`,
        "fix the failure and resend as an explicit new request",
      ],
      submission_complete,
      qualified: false,
      tries: tries.length,
    };
  }
  return {
    state: "candidate",
    exit: 0,
    attempt,
    session: sessionId,
    fence,
    detail: `runner exited 0 after ${String(tries.length)} bounded try/tries; submissions report completion separately`,
    next: [`inspect candidates under ${options.attemptDir}`, "validate before any acceptance"],
    submission_complete,
    qualified: false,
    tries: tries.length,
  };
}

/**
 * Reset one attempt: advance its fence, supersede its live session,
 * discard pending candidate/binding/schema state, and mark its
 * request superseded so a resend starts fresh. Current saved files
 * live outside the attempt dir and are never touched.
 */
export async function resetAttempt(options: {
  attemptDir: string;
  session?: McpSession;
  stateDir?: string;
  coordinationRoot?: string;
  now?: () => number;
}): Promise<number> {
  const now = options.now ?? Date.now;
  const fence = await advanceFence(options.attemptDir, "reset", now);
  options.session?.supersede("reset");
  for (const rel of ["candidates", SESSION_BINDING_FILE, "output-schema.json"]) {
    try {
      await rm(join(options.attemptDir, rel), { recursive: true, force: true });
    } catch {
      // Pending state removal is best-effort; the fence already moved.
    }
  }
  if (options.stateDir !== undefined) {
    let record: AttemptRecord | undefined;
    try { record = await readAttempt(options.attemptDir); }
    catch (error) {
      if (!(error instanceof LifecycleError) || error.code !== "unknown-session") throw error;
      // An unlaunched attempt may have only its fence and capture.
    }
    const requestIds = new Set(record === undefined ? [] : [record.request_id]);
    // A durable claim can precede attempt.json (for example while probing the
    // executable). Recover those exact attempt owners through the same ledger.
    let entries: string[];
    try { entries = await readdir(join(options.stateDir, "requests")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      entries = [];
    }
    for (const entry of entries.filter(name => name.endsWith(".json"))) {
      const pending = JSON.parse(await readFile(join(options.stateDir, "requests", entry), "utf8")) as LedgerRecord;
      if (pending?.attempt_dir === resolve(options.attemptDir) && typeof pending.request_id === "string") requestIds.add(pending.request_id);
    }
    for (const id of requestIds) await markSuperseded(options.stateDir, id, options.coordinationRoot);
  }
  return fence;
}

/**
 * Cancel one attempt best-effort: abort its live run when the
 * registry holds it, signal its recorded pid, advance its fence,
 * and supersede its live session. Late output cannot promote.
 */
export async function cancelAttempt(options: {
  attemptDir: string;
  session?: McpSession;
  registry?: RunRegistry;
  registryKey?: string;
  now?: () => number;
}): Promise<number> {
  const now = options.now ?? Date.now;
  if (options.registry !== undefined && options.registryKey !== undefined) {
    options.registry.get(options.registryKey)?.abort();
  }
  try {
    const record = await readAttempt(options.attemptDir);
    if (record.pid !== null) {
      try {
        process.kill(record.pid, "SIGTERM");
      } catch {
        // The process is already gone; the fence still moves.
      }
    }
  } catch (error) {
    if (!(error instanceof LifecycleError)) throw error;
  }
  const fence = await advanceFence(options.attemptDir, "cancel", now);
  options.session?.supersede("cancel");
  return fence;
}

/** Resume one recorded runner session against an applicable capture. */
export interface ResumeOptions {
  /** New caller request id for the resumed run. */
  request_id: string;
  /** Canonical request input (hashed for the ledger). */
  input: unknown;
  /** Recorded attempt dir holding attempt.json and its fence. */
  recordedAttemptDir: string;
  /** Current capture digest; mismatch with the recording conflicts. */
  capture_digest: string;
  /** Prompt to send after resuming. */
  prompt: string;
  /** Host-owned attempt scratch for the resumed run. */
  attemptDir: string;
  /** Host-owned ledger root for request idempotency. */
  stateDir: string;
  /** Existing lease root for request metadata (defaults to stateDir). */
  coordinationRoot?: string;
  /** Additional owning-control check; never replaces the lifecycle permission gates. */
  assertCurrent?: () => Promise<void>;
  /** Permitted output targets for the resumed run. */
  allowed: AllowedTarget[];
  /** JSON Schema text for the structured final message. */
  outputSchema?: string;
  /** Required handles (defaults to every allowed handle). */
  required?: readonly string[];
  /**
   * MCP stdio bridge attached to the resume (the production
   * `defaultMcpBridge()` serves the attempt's live session).
   * Explicit null attaches no transport: the fake/test path, where
   * submissions arrive through `onSession` instead.
   */
  mcpBridge?: McpBridge | null;
  /** Codex home for the bounded per-attempt profile layer (default: `defaultCodexHome()`). */
  codexHome?: string;
  /** Per-attempt profile name. */
  profileName?: string;
  /** Cancel signal (lifecycle kills and fences on abort). */
  signal?: AbortSignal;
  /** Clock for stamps (tests inject a fixed clock). */
  now?: () => number;
  /** Launch gate (default: BGI-03 preflightResume; test-only override). */
  preflight?: (recipe: EffectiveRecipe) => void;
  /** Executable resolver (default: PATH probe; fakes inject a path). */
  resolveExecutable?: (binaries: readonly string[]) => Promise<string>;
  /** Progress callback (BGI-12 maps phases to JSONL events). */
  onEvent?: (phase: JobPhase, detail: string) => void;
  /** Session hook: tests submit through the live MCP session here; production submissions arrive over the bridge. */
  onSession?: (session: McpSession) => void;
}

/**
 * Resume a specific recorded runner session when the adapter
 * supports it and the capture is still applicable. Changed captures
 * conflict, fenced attempts refuse, and unrecorded sessions refuse;
 * the resumed run reuses the recorded recipe and snapshot.
 */
async function runResumeTry(
  adapter: ReturnType<typeof adapterFor>,
  launch: AdapterLaunch,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  record: AttemptRecord,
  attempt: string,
  tryNo: number,
  emit: NonNullable<ResumeOptions["onEvent"]>,
  persist: () => Promise<void>,
): Promise<TryOutcome> {
  emit(tryNo === 1 ? "launched" : "retry", `resume ${JSON.stringify(attempt)} try ${String(tryNo)}`);
  let pidWrite: Promise<void> | null = null;
  let pidFailure: unknown;
  const capture = await spawnBounded(
    launch,
    timeoutMs,
    signal,
    (pid) => {
      record.pid = pid;
      pidWrite = persist().catch(error => { pidFailure = error; });
    },
  );
  if (pidWrite !== null) await pidWrite;
  if (pidFailure !== undefined) throw pidFailure;
  if (capture.runnerSession !== null) record.runner_session = capture.runnerSession;
  await persist();
  const parsed = adapter.parseResult({
    exitCode: capture.exitCode,
    signal: capture.signal,
    stdout: capture.stdout,
    stderr: capture.stderr,
    timedOut: capture.timedOut,
    ...(capture.spawnError === undefined ? {} : { spawnError: capture.spawnError }),
  });
  return { capture, parsed };
}

async function settleResumeTries(
  options: ResumeOptions,
  attempt: string,
  sessionId: string,
  session: McpSession,
  fence: number,
  attemptDir: string,
  now: () => number,
  tries: TryOutcome[],
): Promise<RequestOutcome> {
  const aborted = options.signal?.aborted ?? false;
  const last = tries[tries.length - 1];
  if (aborted || (last !== undefined && last.capture.cancelled)) {
    const fenced = await advanceFence(attemptDir, "cancel", now);
    session.supersede("cancel");
    return resumedOutcome(options, attempt, sessionId, fenced, tries, session.completion().complete, {
      state: "cancelled",
      exit: EXIT_RUNNER,
      detail: "resumed run cancelled; the attempt fence advanced and late output cannot promote",
      next: [`inspect the fenced attempt at ${attemptDir}`, "start explicit new work with a new request id"],
    });
  }
  if (last === undefined) {
    return resumedOutcome(options, attempt, sessionId, fence, tries, session.completion().complete, {
      state: "failed",
      exit: EXIT_RUNNER,
      detail: "resumed run ended before any bounded try launched",
      next: ["resend with a new request id"],
    });
  }
  if (last.parsed.kind === "unknown") {
    return resumedOutcome(options, attempt, sessionId, fence, tries, session.completion().complete, {
      state: "unknown",
      exit: EXIT_UNKNOWN,
      detail: last.parsed.detail,
      next: [
        `recover by session ${sessionId} when the adapter supports it`,
        "or start an explicit new attempt acknowledging possible duplicate work and cost",
      ],
    });
  }
  if (last.parsed.kind === "known-failure") {
    return resumedOutcome(options, attempt, sessionId, fence, tries, session.completion().complete, {
      state: "failed",
      exit: EXIT_RUNNER,
      detail: `resumed runner failed after ${String(tries.length)} bounded try/tries: ${last.parsed.detail}`,
      next: [`inspect the attempt at ${attemptDir}`, "fix the failure and resend as an explicit new request"],
    });
  }
  return resumedOutcome(options, attempt, sessionId, fence, tries, session.completion().complete, {
    state: "candidate",
    exit: 0,
    detail: `resumed runner exited 0 after ${String(tries.length)} bounded try/tries; submissions report completion separately`,
    next: [`inspect candidates under ${attemptDir}`, "validate before any acceptance"],
  });
}

export async function resumeSession(options: ResumeOptions): Promise<RequestOutcome> {
  if (options.request_id.length === 0) {
    throw new LifecycleError(EXIT_INVALID, "invalid-request", "resume needs a request id");
  }
  if (options.prompt.length === 0) {
    throw new LifecycleError(EXIT_INVALID, "invalid-request", "resume needs a non-empty prompt");
  }
  const now = options.now ?? Date.now;
  const emit = options.onEvent ?? ((): void => {});
  const inputHash = hashInput(options.input);
  const lookup = await lookupRequest(options.stateDir, options.request_id, inputHash);
  if (lookup.status === "same") {
    emit("recovered", `request ${JSON.stringify(options.request_id)} recovers its recorded outcome; no relaunch`);
    return lookup.outcome;
  }
  if (lookup.status === "conflict") {
    throw new LifecycleError(
      EXIT_CONFLICT,
      "request-conflict",
      `request ${JSON.stringify(options.request_id)} carries changed input; a new id is required for new work`,
    );
  }
  const recorded = await readAttempt(options.recordedAttemptDir);
  const recordedFence = await readFence(options.recordedAttemptDir);
  if (recordedFence !== recorded.fence) {
    // An identical concurrent resume may have claimed and fenced the recording
    // since the optimistic lookup. Recover it before refusing stale new work.
    const replay = await lookupRequest(options.stateDir, options.request_id, inputHash);
    if (replay.status === "same") return replay.outcome;
    if (replay.status === "conflict") throw new LifecycleError(EXIT_CONFLICT, "request-conflict", "Request id carries changed input; use a new id for new work.");
    throw new LifecycleError(
      EXIT_CONFLICT,
      "session-superseded",
      `recorded session ${JSON.stringify(recorded.session)} was fenced (${String(recorded.fence)} -> ${String(recordedFence)}); late resume refuses`,
    );
  }
  if (recorded.runner_session === null) {
    throw new LifecycleError(
      EXIT_RUNNER,
      "no-recorded-session",
      `recorded attempt ${JSON.stringify(recorded.attempt)} has no runner session id; start explicit new work instead`,
    );
  }
  if (recorded.capture_digest !== options.capture_digest) {
    throw new LifecycleError(
      EXIT_CONFLICT,
      "capture-changed",
      "the current capture no longer matches the recording; resume refuses and explicit new work is required",
    );
  }
  const preflight = options.preflight ?? preflightResume;
  preflight(recorded.recipe);
  await options.assertCurrent?.();
  const reservation = await claimJobRequest(options, inputHash, "resume");
  if ("outcome" in reservation) return reservation.outcome;
  const adapter = adapterFor(recorded.recipe.runner);
  const resolveExecutable = options.resolveExecutable ?? probeExecutable;
  const executable = await resolveExecutable(adapter.probeBinaries());
  await options.assertCurrent?.();
  // The resumed run links back to its recording; the recording is
  // fenced so its stale session can never resume twice.
  await advanceFence(options.recordedAttemptDir, `resumed by ${options.request_id}`, now);
  const fence = reservation.fence;
  if (await readFence(options.attemptDir) !== fence) throw new LifecycleError(EXIT_CONFLICT, "session-superseded", "Attempt was fenced after request admission.");
  const attempt = `${options.request_id}.g${String(fence)}.resume`;
  const sessionId = `${options.request_id}.g${String(fence)}.s`;
  const session = await createMcpSession({
    session: sessionId,
    attempt,
    source_digest: options.capture_digest,
    allowed: options.allowed,
    candidateRoot: join(options.attemptDir, "candidates"),
    ...(options.required === undefined ? {} : { required: options.required }),
    now,
  });
  options.onSession?.(session);
  const sessionFile = join(options.attemptDir, SESSION_BINDING_FILE);
  const binding: SessionBinding = {
    session: sessionId,
    attempt,
    source_digest: options.capture_digest,
    fence,
    allowed: options.allowed.length,
    created_at: new Date(now()).toISOString(),
  };
  await withJobClaim(options, reservation.claim, () => writeFile(sessionFile, `${JSON.stringify(binding, null, 2)}\n`));
  const record: AttemptRecord = {
    attempt,
    session: sessionId,
    request_id: options.request_id,
    capture_digest: options.capture_digest,
    snapshotDir: recorded.snapshotDir,
    recipe: recorded.recipe,
    fence,
    runner_session: recorded.runner_session,
    pid: null,
    resumed_from: recorded.attempt,
    state: "running",
  };
  await withJobClaim(options, reservation.claim, () => writeAttempt(options.attemptDir, record));
  const launch = await adapter.buildResumeLaunch(
    {
      recipe: recorded.recipe,
      snapshotDir: recorded.snapshotDir,
      attemptDir: options.attemptDir,
      sessionFile,
      prompt: options.prompt,
      outputSchema: options.outputSchema ?? DEFAULT_OUTPUT_SCHEMA,
      mcpBridge: options.mcpBridge ?? null,
      codexHome: options.codexHome ?? defaultCodexHome(),
      profileName: options.profileName ?? `can-gen-${attempt}`,
    },
    recorded.runner_session,
  );
  launch.file = executable;
  emit("planned", `resume ${JSON.stringify(attempt)} continues runner session ${JSON.stringify(recorded.runner_session)}`);
  let outcome: RequestOutcome;
  try {
    outcome = await withReadOnlySnapshot(recorded.snapshotDir, async () => {
      const tries: TryOutcome[] = [];
      for (let tryNo = 1; tryNo <= recorded.recipe.max_attempts; tryNo += 1) {
        if (options.signal?.aborted ?? false) break;
        await options.assertCurrent?.();
        await withJobClaim(options, reservation.claim, async () => {
          if (await readFence(options.attemptDir) !== fence) throw new LifecycleError(EXIT_CONFLICT, "session-superseded", "Attempt changed before resume launch.");
        });
        const outcome = await runResumeTry(adapter, launch, recorded.recipe.timeout_seconds * 1000,
          options.signal, record, attempt, tryNo, emit,
          () => withJobClaim(options, reservation.claim, () => writeAttempt(options.attemptDir, record)));
        tries.push(outcome);
        if (outcome.capture.cancelled || (options.signal?.aborted ?? false)) break;
        if (outcome.parsed.kind === "ok") break;
        if (outcome.parsed.kind === "unknown") break;
        if (!outcome.parsed.retryable) break;
      }
      return settleResumeTries(options, attempt, sessionId, session, fence, options.attemptDir, now, tries);
    });
  } finally {
    for (const file of launch.cleanupFiles) {
      await removeCodexMcpProfile(file);
    }
  }
  record.state = outcome.state;
  record.pid = null;
  await withJobClaim(options, reservation.claim, () => writeAttempt(options.attemptDir, record));
  await storeRequest(options.stateDir, options.request_id, inputHash, outcome, reservation.claim, options.coordinationRoot);
  emit("completed", `resume ${JSON.stringify(attempt)} ${outcome.state}: ${outcome.detail}`);
  return outcome;
}

function resumedOutcome(
  options: ResumeOptions,
  attempt: string,
  sessionId: string,
  fence: number,
  tries: TryOutcome[],
  submission_complete: boolean,
  terminal: { state: RequestOutcome["state"]; exit: number; detail: string; next: string[] },
): RequestOutcome {
  void options;
  return {
    state: terminal.state,
    exit: terminal.exit,
    attempt,
    session: sessionId,
    fence,
    detail: terminal.detail,
    next: terminal.next,
    submission_complete,
    qualified: false,
    tries: tries.length,
  };
}
