/**
 * Generation runner adapters (BGI-05): one adapter interface plus the
 * Codex implementation. The adapter builds argv arrays (never shell
 * strings), attaches the host-owned MCP session binding, enforces
 * read-only generator flags that no parameter can relax, and parses
 * the bounded process outcome into ok / known-failure / unknown.
 * Other runners are BGI-06's; this file refuses to invent them.
 *
 * Codex argv follows the locally verified `codex-cli 0.157.1` help:
 * `exec --json -s read-only -C DIR -m MODEL --output-schema FILE -`
 * with the prompt on stdin, MCP stdio servers through
 * `[mcp_servers."can-generation"]` profile config, and
 * `exec resume SESSION_ID` (which keeps its recorded root/sandbox,
 * so resume argv carries no `-C`/`-s`). Real authenticated runs and
 * actual no-write qualification stay on the held external gate.
 */

import { access, constants, mkdir, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { EffectiveRecipe, NativeMap } from "./config.js";

/** Name of the Can generation MCP server in Codex profile config. */
export const CODEX_MCP_SERVER_NAME = "can-generation";
/** Env var carrying the host-written MCP session binding path. */
export const SESSION_FILE_ENV = "CAN_GENERATION_SESSION_FILE";
/** Host-written structured-result schema filename inside an attempt. */
export const OUTPUT_SCHEMA_FILE = "output-schema.json";
/** Host-written MCP session binding filename inside an attempt. */
export const SESSION_BINDING_FILE = "session.json";

/** Typed adapter failure (unknown runner, unresolvable binary, ...). */
export class AdapterError extends Error {
  /** Machine-readable code (`unknown-adapter`, ...). */
  readonly code: string;
  /** Human-actionable detail without the code prefix. */
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`[${code}] ${detail}`);
    this.name = "AdapterError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The qualified MCP stdio bridge command (host-owned executable plus
 * argv). `null` until the external gate qualifies the real wire
 * transport; fakes and tests use the session binding file instead.
 */
export interface McpBridge {
  /** Host-owned bridge executable (absolute path). */
  command: string;
  /** Fixed bridge argv (no caller interpolation). */
  args: readonly string[];
}

/** Everything one adapter needs to launch a bounded runner job. */
export interface RunnerJobInput {
  /** Effective recipe (runner, model, limits, native map). */
  recipe: EffectiveRecipe;
  /** Captured read-only snapshot the agent works from. */
  snapshotDir: string;
  /** Host-owned attempt scratch (binding, schema, candidates). */
  attemptDir: string;
  /** Host-written MCP session binding path. */
  sessionFile: string;
  /** Full agent prompt, delivered on stdin (never spliced). */
  prompt: string;
  /** JSON Schema text constraining the final structured message. */
  outputSchema: string;
  /** Qualified stdio bridge, or null while the gate is held. */
  mcpBridge: McpBridge | null;
  /** Codex home receiving the bounded per-attempt profile layer. */
  codexHome: string;
  /** Per-attempt profile name (`<name>.config.toml` under codexHome). */
  profileName: string;
}

/** A fully built process launch: argv array, cwd, extra env, stdin. */
export interface AdapterLaunch {
  /** Resolved executable path (never a shell string). */
  file: string;
  /** Complete argv array (no shell metacharacter interpretation). */
  args: string[];
  /** Spawn working directory (host-owned attempt scratch). */
  cwd: string;
  /** Extra env over the inherited environment. */
  env: Record<string, string>;
  /** Prompt bytes for the child's stdin. */
  stdin: string;
  /** Host-written files the lifecycle must remove after the run. */
  cleanupFiles: string[];
}

/** Raw bounded-process outcome for structured-result parsing. */
export interface RawOutcome {
  /** Process exit code, or null when killed/signalled. */
  exitCode: number | null;
  /** Kill signal name, or null for a natural exit. */
  signal: string | null;
  /** Captured stdout (bounded by the lifecycle). */
  stdout: string;
  /** Captured stderr (bounded by the lifecycle). */
  stderr: string;
  /** True when the lifecycle's finite timeout fired first. */
  timedOut: boolean;
  /** Spawn-level failure (missing binary, denied exec), if any. */
  spawnError?: string;
}

/**
 * Parsed runner result. `ok` reports a clean exit only; required
 * outputs still qualify exclusively through MCP submissions plus
 * the separate BGI-11/12 validation/acceptance phases. Unknown
 * completion (timeout/kill/disconnect) never auto-repeats.
 */
export type RunnerResult =
  | { readonly kind: "ok"; readonly detail: string }
  | { readonly kind: "known-failure"; readonly retryable: boolean; readonly detail: string }
  | { readonly kind: "unknown"; readonly detail: string };

/** One runner adapter: argv, MCP attachment, structured results. */
export interface RunnerAdapter {
  /** Runner id (`codex` today; BGI-06 adds the rest). */
  readonly id: string;
  /** Executable names probed on PATH, in order. */
  probeBinaries(): readonly string[];
  /** Build a fresh bounded launch, writing host-owned support files. */
  buildLaunch(job: RunnerJobInput): Promise<AdapterLaunch>;
  /** Build a recorded-session resume launch for an applicable capture. */
  buildResumeLaunch(job: RunnerJobInput, recordedSessionId: string): Promise<AdapterLaunch>;
  /** Parse a raw bounded outcome into ok/known-failure/unknown. */
  parseResult(outcome: RawOutcome): RunnerResult;
}

/**
 * Resolve the first executable found on PATH. Reports every probed
 * name on failure, never a silent pass.
 */
export async function probeExecutable(
  binaries: readonly string[],
  pathEnv?: string,
): Promise<string> {
  const pathValue = pathEnv ?? process.env["PATH"] ?? "";
  const tried: string[] = [];
  for (const binary of binaries) {
    if (binary.includes("/") || binary.includes("\\")) {
      tried.push(binary);
      continue;
    }
    for (const dir of pathValue.split(delimiter)) {
      if (dir.length === 0) continue;
      const candidate = join(dir, binary);
      tried.push(candidate);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  throw new AdapterError(
    "executable-not-found",
    `no runner executable found; tried ${tried.length === 0 ? "(nothing on PATH)" : tried.join(", ")}`,
  );
}

function tomlScalar(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AdapterError("invalid-native-option", "native numbers must be finite for `-c key=value`");
    }
    return String(value);
  }
  // JSON basic strings share TOML's escapes for `"`, `\`, and the
  // short control forms, so quoted JSON is a valid TOML string here.
  return JSON.stringify(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Render preflight-accepted native options as `-c key=value` pairs. */
function nativeArgs(native: NativeMap): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(native)) {
    args.push("-c", `${key}=${tomlScalar(value)}`);
  }
  return args;
}

/** Bounded tail of captured output for failure detail (never unbounded). */
function outputTail(text: string, limit = 2048): string {
  if (text.length <= limit) return text;
  return `…(truncated)…${text.slice(text.length - limit)}`;
}

/**
 * Best-effort scan of `--json` JSONL stdout for an explicit error
 * item. Failures to parse never throw; plain text stays plain text.
 */
function scanJsonlError(stdout: string): string | null {
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
    const kind = record["type"];
    if (kind !== "error" && kind !== "turn.failed" && kind !== "thread.failed") continue;
    const message = record["message"];
    return typeof message === "string" && message.length > 0 ? message : `runner reported ${String(kind)}`;
  }
  return null;
}

/**
 * Write the bounded per-attempt Codex profile layer carrying the
 * `[mcp_servers."can-generation"]` stdio entry. Returns the profile
 * path for lifecycle cleanup. Auth still uses the real codex home;
 * only this attempt's MCP entry is layered and later removed.
 */
export async function writeCodexMcpProfile(options: {
  codexHome: string;
  profileName: string;
  bridge: McpBridge;
  sessionFile: string;
  attemptDir: string;
}): Promise<string> {
  if (options.profileName.length === 0 || !/^[A-Za-z0-9_.-]+$/.test(options.profileName)) {
    throw new AdapterError(
      "invalid-profile",
      `profile names are bare [A-Za-z0-9_.-]+ names, got ${JSON.stringify(options.profileName)}`,
    );
  }
  const lines = [
    `## Can generation MCP attachment for one bounded attempt; removed after the run.`,
    `[mcp_servers.${JSON.stringify(CODEX_MCP_SERVER_NAME)}]`,
    `command = ${tomlString(options.bridge.command)}`,
    `args = [${options.bridge.args.map((arg) => tomlString(arg)).join(", ")}]`,
    `cwd = ${tomlString(options.attemptDir)}`,
    `startup_timeout_sec = 60`,
    ``,
    `[mcp_servers.${JSON.stringify(CODEX_MCP_SERVER_NAME)}.env]`,
    `${SESSION_FILE_ENV} = ${tomlString(options.sessionFile)}`,
    ``,
  ];
  const path = join(options.codexHome, `${options.profileName}.config.toml`);
  await mkdir(options.codexHome, { recursive: true });
  await writeFile(path, lines.join("\n"));
  return path;
}

/** Remove a per-attempt profile layer; missing files are already gone. */
export async function removeCodexMcpProfile(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }
}

function checkJob(job: RunnerJobInput): void {
  if (job.snapshotDir.length === 0) throw new AdapterError("invalid-job", "runner jobs need a snapshot dir");
  if (job.attemptDir.length === 0) throw new AdapterError("invalid-job", "runner jobs need an attempt dir");
  if (job.sessionFile.length === 0) throw new AdapterError("invalid-job", "runner jobs need a session binding");
  if (job.prompt.length === 0) throw new AdapterError("invalid-job", "runner jobs need a non-empty prompt");
  if (job.outputSchema.length === 0) {
    throw new AdapterError("invalid-job", "runner jobs need a structured-result schema");
  }
  try {
    JSON.parse(job.outputSchema);
  } catch {
    throw new AdapterError("invalid-job", "the structured-result schema must be JSON");
  }
}

/** The Codex adapter: verified `codex exec` / `exec resume` argv. */
export const codexAdapter: RunnerAdapter = {
  id: "codex",

  probeBinaries(): readonly string[] {
    return ["codex"];
  },

  async buildLaunch(job: RunnerJobInput): Promise<AdapterLaunch> {
    checkJob(job);
    await mkdir(job.attemptDir, { recursive: true });
    const schemaPath = join(job.attemptDir, OUTPUT_SCHEMA_FILE);
    await writeFile(schemaPath, job.outputSchema);
    const cleanupFiles: string[] = [];
    const extra: string[] = [];
    if (job.mcpBridge !== null) {
      const profile = await writeCodexMcpProfile({
        codexHome: job.codexHome,
        profileName: job.profileName,
        bridge: job.mcpBridge,
        sessionFile: job.sessionFile,
        attemptDir: job.attemptDir,
      });
      cleanupFiles.push(profile);
      extra.push("-p", job.profileName);
    }
    // Verified `codex exec` shape: structured JSONL events, a
    // read-only shell sandbox that no parameter relaxes, the
    // captured snapshot as working root, explicit model, schema
    // constrained final message, prompt on stdin (`-`).
    return {
      file: "codex",
      args: [
        "exec",
        "--json",
        "--color",
        "never",
        "-s",
        "read-only",
        "-C",
        job.snapshotDir,
        "-m",
        job.recipe.model,
        "--output-schema",
        schemaPath,
        ...nativeArgs(job.recipe.native),
        ...extra,
        "-",
      ],
      cwd: job.attemptDir,
      env: { [SESSION_FILE_ENV]: job.sessionFile },
      stdin: job.prompt,
      cleanupFiles,
    };
  },

  async buildResumeLaunch(job: RunnerJobInput, recordedSessionId: string): Promise<AdapterLaunch> {
    checkJob(job);
    if (recordedSessionId.length === 0) {
      throw new AdapterError("invalid-resume", "resume needs the recorded runner session id");
    }
    await mkdir(job.attemptDir, { recursive: true });
    const schemaPath = join(job.attemptDir, OUTPUT_SCHEMA_FILE);
    await writeFile(schemaPath, job.outputSchema);
    const cleanupFiles: string[] = [];
    const extra: string[] = [];
    if (job.mcpBridge !== null) {
      const profile = await writeCodexMcpProfile({
        codexHome: job.codexHome,
        profileName: job.profileName,
        bridge: job.mcpBridge,
        sessionFile: job.sessionFile,
        attemptDir: job.attemptDir,
      });
      cleanupFiles.push(profile);
      extra.push("-p", job.profileName);
    }
    // Verified `codex exec resume` shape: no `-C`/`-s` (the recorded
    // session keeps its root/sandbox), same JSONL/model/schema/stdin
    // handling as a fresh launch.
    return {
      file: "codex",
      args: [
        "exec",
        "resume",
        recordedSessionId,
        "--json",
        "--color",
        "never",
        "-m",
        job.recipe.model,
        "--output-schema",
        schemaPath,
        ...nativeArgs(job.recipe.native),
        ...extra,
        "-",
      ],
      cwd: job.attemptDir,
      env: { [SESSION_FILE_ENV]: job.sessionFile },
      stdin: job.prompt,
      cleanupFiles,
    };
  },

  parseResult(outcome: RawOutcome): RunnerResult {
    if (outcome.spawnError !== undefined) {
      return {
        kind: "known-failure",
        retryable: false,
        detail: `runner did not start (${outcome.spawnError}); check doctor before retrying`,
      };
    }
    if (outcome.timedOut) {
      return {
        kind: "unknown",
        detail:
          "runner timed out and was killed; a timeout never proves provider work stopped, " +
          "so completion is unknown and only an explicit new attempt may continue",
      };
    }
    if (outcome.signal !== null) {
      return {
        kind: "unknown",
        detail:
          `runner died to signal ${outcome.signal}; completion is unknown ` +
          "and only an explicit new attempt may continue",
      };
    }
    if (outcome.exitCode === 0) {
      return { kind: "ok", detail: "runner exited 0" };
    }
    const reported = scanJsonlError(outcome.stdout);
    const tail = outputTail(
      outcome.stderr.length > 0 ? outcome.stderr : outcome.stdout,
    );
    const detail =
      reported !== null
        ? `runner exited ${String(outcome.exitCode)}: ${reported}`
        : `runner exited ${String(outcome.exitCode)}${tail.length > 0 ? `: ${tail}` : ""}`;
    return { kind: "known-failure", retryable: true, detail: detail.slice(0, 4096) };
  },
};

/**
 * Select the one implemented adapter. Other frozen runner ids refuse
 * here; BGI-06 owns their adapters, not a guess in this file.
 */
export function adapterFor(runner: string): RunnerAdapter {
  if (runner === codexAdapter.id) return codexAdapter;
  throw new AdapterError(
    "unknown-adapter",
    `runner \`${runner}\` has no BGI-05 adapter (BGI-06 owns the remaining adapters)`,
  );
}
