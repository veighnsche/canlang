/**
 * Generation runner adapters (BGI-05 interface plus BGI-06): one
 * adapter interface with Codex, Muse, Claude Code and OpenCode
 * implementations. Each adapter builds argv arrays (never shell
 * strings), attaches the host-owned MCP session binding, enforces
 * read-only generator controls that no parameter can relax, and
 * parses the bounded process outcome into ok / known-failure /
 * unknown. All four adapters remain required.
 *
 * Codex argv follows the locally verified `codex-cli 0.157.1` help:
 * `exec --json -s read-only -C DIR -m MODEL --output-schema FILE -`
 * with the prompt on stdin, MCP stdio servers through
 * `[mcp_servers."can-generation"]` profile config, and
 * `exec resume SESSION_ID` (which keeps its recorded root/sandbox,
 * so resume argv carries no `-C`/`-s`). Real authenticated runs and
 * actual no-write qualification stay on the held external gate.
 *
 * BGI-06 argv follows the locally installed tools plus their primary
 * documentation. Muse (`muse` 1.4.7, verified live with the echo
 * provider): `exec --json --model ID --output-schema FILE
 * --workspace DIR --prompt-file FILE --disable-approval
 * --disable-write --disable-shell --disable-web-tools` with MCP
 * stdio servers through `-c 'mcpServers.<name>={...}'` (per-server
 * addressing only; env values must be whole-value `${VAR}`
 * indirections) and no headless resume (`resume` is interactive
 * only; reusing `--session-id` starts a fresh run, verified by the
 * absent prior transcript). Claude Code (`claude` 2.1.281, verified
 * live up to authentication): `claude -p PROMPT --model ID
 * --output-format json --json-schema SCHEMA --tools Read,Glob,Grep
 * --permission-mode dontAsk --permission-prompts none --restricted
 * --strict-mcp-config --mcp-config FILE --allowedTools
 * mcp__<server>__<tool>,...` with resume through `-p --resume ID`.
 * OpenCode (`opencode` 2.0.16, verified live up to authentication):
 * `opencode run --standalone --format json --model PROVIDER/MODEL
 * MESSAGE` with MCP plus a default-deny permission block through an
 * `OPENCODE_CONFIG` file (`--standalone` is mandatory: the shared
 * background server pins stale config across directories, verified
 * live) and resume through `--session ID`. Model ids pass through
 * untouched; no desktop model identifiers or cross-provider
 * semantics are assumed. Real authenticated runs, live MCP
 * attachment and actual no-write enforcement stay on the held
 * external gate per adapter.
 */

import { access, constants, mkdir, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { EffectiveRecipe, NativeMap } from "./config.js";
import { MCP_CONTEXT_TOOL, MCP_SUBMIT_TOOL } from "./protocol.js";

/** Name of the Can generation MCP server in Codex profile config. */
export const CODEX_MCP_SERVER_NAME = "can-generation";
/** Shared host-owned MCP server name across all four adapters. */
export const GENERATION_MCP_SERVER_NAME = CODEX_MCP_SERVER_NAME;
/** Env var carrying the host-written MCP session binding path. */
export const SESSION_FILE_ENV = "CAN_GENERATION_SESSION_FILE";
/** Host-written structured-result schema filename inside an attempt. */
export const OUTPUT_SCHEMA_FILE = "output-schema.json";
/** Host-written MCP session binding filename inside an attempt. */
export const SESSION_BINDING_FILE = "session.json";
/** Host-written prompt filename inside an attempt (Muse `--prompt-file`). */
export const PROMPT_FILE = "prompt.txt";
/** Host-written Claude `--mcp-config` filename inside an attempt. */
export const CLAUDE_MCP_FILE = "claude-mcp.json";
/** Host-written OpenCode `OPENCODE_CONFIG` filename inside an attempt. */
export const OPENCODE_CONFIG_FILE = "opencode.json";
/** Env var pointing OpenCode at the per-attempt config file. */
export const OPENCODE_CONFIG_ENV = "OPENCODE_CONFIG";

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
  /** Runner id (`codex`, `muse`, `claude-code`, `opencode`). */
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

/**
 * Render preflight-accepted native options as Muse `-c key=JSON`
 * pairs. Muse refuses unknown or clashing keys loudly before the
 * run, so rendering is safe: nothing silently widens. Dotted keys
 * address nested settings, matching Muse's own `-c` shape.
 */
function museNativeArgs(native: NativeMap): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(native)) {
    args.push("-c", `${key}=${JSON.stringify(value)}`);
  }
  return args;
}

/**
 * Refuse native options for adapters whose tool offers no safe
 * per-key override channel. Merging flat keys into Claude
 * `--settings` or an OpenCode config file could silently widen
 * permission and tooling controls, so a non-empty map diagnoses
 * instead of rendering. Empty maps (the only preflight-admitted
 * shape today) pass through.
 */
function refuseNative(native: NativeMap, runner: string, why: string): void {
  const keys = Object.keys(native);
  if (keys.length === 0) return;
  throw new AdapterError(
    "unsupported-native-option",
    `runner \`${runner}\` documents no safe native channel for ${keys
      .map((key) => `\`${key}\``)
      .join(", ")} (${why}); documenting keys is a protocol-table change, not an adapter guess`,
  );
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
 * Best-effort scan of Muse `--json` JSONL stdout for the terminal
 * failure event. Verified shape: a `run.terminal.failed` record
 * carrying the human-readable `reason`. Parse failures never throw.
 */
function scanMuseTerminalError(stdout: string): string | null {
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
    if (record["payload_type"] !== "run.terminal.failed") continue;
    const payload = record["payload"] as Record<string, unknown> | undefined;
    const reason = payload?.["reason"];
    return typeof reason === "string" && reason.length > 0
      ? reason
      : "muse reported run.terminal.failed";
  }
  return null;
}

/**
 * Best-effort read of the Claude `--output-format json` result
 * object. Verified shape: one JSON object with `is_error` plus the
 * human-readable `result` text. Anything else stays plain text.
 */
function scanClaudeResultError(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["is_error"] !== true) return null;
  const result = record["result"];
  return typeof result === "string" && result.length > 0 ? result : "claude reported is_error";
}

/**
 * Best-effort scan of OpenCode `--format json` event stdout for an
 * error event. Verified shape: `{"type":"error","error":{"message":
 * ...}}` (provider, session-lookup and auth failures share it).
 * Parse failures never throw.
 */
function scanOpencodeErrorEvent(stdout: string): string | null {
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
    if (record["type"] !== "error") continue;
    const error = record["error"] as Record<string, unknown> | undefined;
    const message = error?.["message"];
    return typeof message === "string" && message.length > 0
      ? message
      : "opencode reported a type:error event";
  }
  return null;
}

/**
 * Parse a raw bounded outcome for the BGI-06 adapters. Same contract
 * as the Codex parser: `ok` reports a clean exit only (required
 * outputs still qualify exclusively through MCP submissions plus
 * the separate BGI-11/12 phases), and unknown completion
 * (timeout/kill/disconnect) never auto-repeats. The caller supplies
 * the adapter's verified in-band error detail, if any.
 */
function parseHeadlessResult(outcome: RawOutcome, scanned: string | null): RunnerResult {
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
  const tail = outputTail(outcome.stderr.length > 0 ? outcome.stderr : outcome.stdout);
  const detail =
    scanned !== null
      ? `runner exited ${String(outcome.exitCode)}: ${scanned}`
      : `runner exited ${String(outcome.exitCode)}${tail.length > 0 ? `: ${tail}` : ""}`;
  return { kind: "known-failure", retryable: true, detail: detail.slice(0, 4096) };
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

/**
 * Write the per-attempt Claude `--mcp-config` file carrying the one
 * `can-generation` stdio entry. The entry shape (command, args, env
 * with a literal session path) follows the installed Claude Code
 * MCP documentation and was verified live: the server spawn was
 * attempted before authentication failed. The file lives in the
 * host-owned attempt scratch, so no separate removal helper is
 * needed.
 */
export async function writeClaudeMcpConfig(options: {
  bridge: McpBridge;
  sessionFile: string;
  attemptDir: string;
}): Promise<string> {
  const config = {
    mcpServers: {
      [GENERATION_MCP_SERVER_NAME]: {
        command: options.bridge.command,
        args: [...options.bridge.args],
        env: { [SESSION_FILE_ENV]: options.sessionFile },
      },
    },
  };
  const path = join(options.attemptDir, CLAUDE_MCP_FILE);
  await mkdir(options.attemptDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

/**
 * Build the OpenCode permission block: default-deny with an explicit
 * read-only allowlist plus the generation MCP tools. Every
 * documented OpenCode permission key appears, so a permissive
 * global config cannot punch through the merge on a missing key:
 * each conflicting key resolves to this later-source block. Keys
 * follow the OpenCode permissions reference (`edit` covers every
 * file modification; permission keys match MCP tool names such as
 * `can-generation_generation_submit` through the
 * `can-generation_*` wildcard).
 */
function opencodePermissionBlock(withMcpTools: boolean): Record<string, string> {
  const block: Record<string, string> = {
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    edit: "deny",
    bash: "deny",
    task: "deny",
    skill: "deny",
    lsp: "deny",
    question: "deny",
    webfetch: "deny",
    websearch: "deny",
    external_directory: "deny",
    doom_loop: "deny",
  };
  if (withMcpTools) {
    block[`${GENERATION_MCP_SERVER_NAME}_*`] = "allow";
  }
  return block;
}

/**
 * Write the per-attempt OpenCode config file: the one
 * `can-generation` local MCP entry plus the default-deny
 * permission block, repeated under `agent.build.permission`
 * because agent rules take precedence over the global block. The
 * shape was verified live under `opencode run --standalone`: the
 * MCP server load was attempted and the permission block parsed
 * without a config error. Always written, even without a
 * qualified bridge, so restriction enforcement never depends on
 * MCP qualification; only the `mcp` section is conditional.
 */
export async function writeOpencodeConfig(options: {
  bridge: McpBridge | null;
  sessionFile: string;
  attemptDir: string;
}): Promise<string> {
  const permission = opencodePermissionBlock(options.bridge !== null);
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    permission,
    agent: { build: { permission: { ...permission } } },
  };
  if (options.bridge !== null) {
    config["mcp"] = {
      [GENERATION_MCP_SERVER_NAME]: {
        type: "local",
        command: [options.bridge.command, ...options.bridge.args],
        environment: { [SESSION_FILE_ENV]: options.sessionFile },
        enabled: true,
      },
    };
  }
  const path = join(options.attemptDir, OPENCODE_CONFIG_FILE);
  await mkdir(options.attemptDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
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
 * Build the Muse `-c` value attaching the host-owned MCP stdio
 * server. Muse addresses one server per `-c` entry
 * (`mcpServers.<name>`; the whole map is refused), and every env
 * value must be exactly one whole-value `${VAR}` naming a variable
 * set in the spawned environment, so the session binding travels
 * through the launch env rather than the config text.
 */
function museMcpSetting(bridge: McpBridge): string {
  return `mcpServers.${GENERATION_MCP_SERVER_NAME}=${JSON.stringify({
    command: bridge.command,
    args: [...bridge.args],
    env: { [SESSION_FILE_ENV]: `\${${SESSION_FILE_ENV}}` },
  })}`;
}

/** The Muse adapter: verified `muse exec` headless argv. */
export const museAdapter: RunnerAdapter = {
  id: "muse",

  probeBinaries(): readonly string[] {
    return ["muse"];
  },

  async buildLaunch(job: RunnerJobInput): Promise<AdapterLaunch> {
    checkJob(job);
    await mkdir(job.attemptDir, { recursive: true });
    const schemaPath = join(job.attemptDir, OUTPUT_SCHEMA_FILE);
    await writeFile(schemaPath, job.outputSchema);
    const promptPath = join(job.attemptDir, PROMPT_FILE);
    await writeFile(promptPath, job.prompt);
    const extra: string[] = [];
    if (job.mcpBridge !== null) {
      extra.push("-c", museMcpSetting(job.mcpBridge));
    }
    // Verified `muse exec` shape: JSONL events, explicit model,
    // schema-constrained final message, the captured snapshot as
    // the workspace root, the full prompt from a host-written file
    // (never spliced into argv), and read-only controls that no
    // parameter relaxes: no approval prompts to hang headless
    // runs, no non-shell workspace writes, no workspace shell, no
    // web tools, with the OS sandbox left on (its default).
    // Provider and authentication stay in user settings; no
    // `--provider` override assumes their semantics.
    return {
      file: "muse",
      args: [
        "exec",
        "--json",
        "--model",
        job.recipe.model,
        "--output-schema",
        schemaPath,
        "--workspace",
        job.snapshotDir,
        "--prompt-file",
        promptPath,
        "--disable-approval",
        "--disable-write",
        "--disable-shell",
        "--disable-web-tools",
        ...museNativeArgs(job.recipe.native),
        ...extra,
      ],
      cwd: job.attemptDir,
      env: { [SESSION_FILE_ENV]: job.sessionFile },
      stdin: "",
      cleanupFiles: [],
    };
  },

  async buildResumeLaunch(job: RunnerJobInput, recordedSessionId: string): Promise<AdapterLaunch> {
    checkJob(job);
    void recordedSessionId;
    // Muse offers no headless recorded-session resume: `muse
    // resume` is interactive only (no prompt flag), and reusing an
    // id through `exec --session-id` starts a fresh run without
    // the prior transcript (verified live). Diagnose instead of
    // faking continuity; only an explicit fresh attempt continues.
    throw new AdapterError(
      "unsupported-resume",
      "muse has no headless recorded-session resume (`muse resume` is interactive only); " +
        "request an explicit fresh attempt instead of resuming",
    );
  },

  parseResult(outcome: RawOutcome): RunnerResult {
    return parseHeadlessResult(outcome, scanMuseTerminalError(outcome.stdout));
  },
};

/**
 * The `mcp__<server>__<tool>` names Claude uses for the two
 * generation tools, joined as one comma-separated `--allowedTools`
 * value. Server/tool spelling follows the MCP tool-name rule
 * (hyphens preserved); tool ids are the frozen protocol constants.
 */
function claudeAllowedMcpTools(): string {
  return [
    `mcp__${GENERATION_MCP_SERVER_NAME}__${MCP_CONTEXT_TOOL}`,
    `mcp__${GENERATION_MCP_SERVER_NAME}__${MCP_SUBMIT_TOOL}`,
  ].join(",");
}

/** The Claude Code adapter: verified `claude -p` headless argv. */
export const claudeAdapter: RunnerAdapter = {
  id: "claude-code",

  probeBinaries(): readonly string[] {
    return ["claude", "claude-code"];
  },

  async buildLaunch(job: RunnerJobInput): Promise<AdapterLaunch> {
    checkJob(job);
    refuseNative(
      job.recipe.native,
      "claude-code",
      "merging flat keys into `--settings` could widen permission controls",
    );
    await mkdir(job.attemptDir, { recursive: true });
    const extra: string[] = [];
    if (job.mcpBridge !== null) {
      const mcpPath = await writeClaudeMcpConfig({
        bridge: job.mcpBridge,
        sessionFile: job.sessionFile,
        attemptDir: job.attemptDir,
      });
      extra.push("--mcp-config", mcpPath, "--allowedTools", claudeAllowedMcpTools());
    }
    // Verified `claude -p` shape: the prompt as a trailing
    // positional (piped stdin is extra context, not the prompt),
    // explicit model, single-JSON output with an inline validated
    // schema, and read-only controls that no parameter relaxes: a
    // read-only built-in tool allowlist (`--tools` never affects
    // MCP tools, so the generation tools stay available), every
    // would-prompt call denied, nothing answering prompts, user
    // and project settings ignored with file tools confined to
    // the working directories, and only `--mcp-config` servers
    // loaded. The spawn directory is the captured snapshot;
    // transcripts persist under the tool's home, never in it.
    return {
      file: "claude",
      args: [
        "-p",
        job.prompt,
        "--model",
        job.recipe.model,
        "--output-format",
        "json",
        "--json-schema",
        job.outputSchema,
        "--tools",
        "Read,Glob,Grep",
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
        "--restricted",
        "--strict-mcp-config",
        ...extra,
      ],
      cwd: job.snapshotDir,
      env: { [SESSION_FILE_ENV]: job.sessionFile },
      stdin: "",
      cleanupFiles: [],
    };
  },

  async buildResumeLaunch(job: RunnerJobInput, recordedSessionId: string): Promise<AdapterLaunch> {
    checkJob(job);
    refuseNative(
      job.recipe.native,
      "claude-code",
      "merging flat keys into `--settings` could widen permission controls",
    );
    if (recordedSessionId.length === 0) {
      throw new AdapterError("invalid-resume", "resume needs the recorded runner session id");
    }
    await mkdir(job.attemptDir, { recursive: true });
    const extra: string[] = [];
    if (job.mcpBridge !== null) {
      const mcpPath = await writeClaudeMcpConfig({
        bridge: job.mcpBridge,
        sessionFile: job.sessionFile,
        attemptDir: job.attemptDir,
      });
      extra.push("--mcp-config", mcpPath, "--allowedTools", claudeAllowedMcpTools());
    }
    // Verified `-p --resume` shape: the recorded session id plus
    // the follow-up prompt, with the same JSON/model/schema and
    // read-only controls as a fresh launch.
    return {
      file: "claude",
      args: [
        "-p",
        job.prompt,
        "--resume",
        recordedSessionId,
        "--model",
        job.recipe.model,
        "--output-format",
        "json",
        "--json-schema",
        job.outputSchema,
        "--tools",
        "Read,Glob,Grep",
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
        "--restricted",
        "--strict-mcp-config",
        ...extra,
      ],
      cwd: job.snapshotDir,
      env: { [SESSION_FILE_ENV]: job.sessionFile },
      stdin: "",
      cleanupFiles: [],
    };
  },

  parseResult(outcome: RawOutcome): RunnerResult {
    return parseHeadlessResult(outcome, scanClaudeResultError(outcome.stdout));
  },
};

/** The OpenCode adapter: verified `opencode run` headless argv. */
export const opencodeAdapter: RunnerAdapter = {
  id: "opencode",

  probeBinaries(): readonly string[] {
    return ["opencode"];
  },

  async buildLaunch(job: RunnerJobInput): Promise<AdapterLaunch> {
    checkJob(job);
    refuseNative(
      job.recipe.native,
      "opencode",
      "merging flat keys into the generated config could widen permission controls",
    );
    await mkdir(job.attemptDir, { recursive: true });
    const configPath = await writeOpencodeConfig({
      bridge: job.mcpBridge,
      sessionFile: job.sessionFile,
      attemptDir: job.attemptDir,
    });
    // Verified `opencode run` shape: a private per-attempt server
    // (never the shared background service, which pins stale
    // config across directories), raw JSON events, an explicit
    // provider/model id passed through untouched, the prompt as
    // the trailing message, and MCP plus default-deny permissions
    // through an `OPENCODE_CONFIG` file (verified live). The
    // spawn directory is the captured snapshot. OpenCode offers
    // no structured-output flag, so required outputs qualify
    // exclusively through MCP submissions, never stdout parsing.
    return {
      file: "opencode",
      args: [
        "run",
        "--standalone",
        "--format",
        "json",
        "--model",
        job.recipe.model,
        job.prompt,
      ],
      cwd: job.snapshotDir,
      env: { [SESSION_FILE_ENV]: job.sessionFile, [OPENCODE_CONFIG_ENV]: configPath },
      stdin: "",
      cleanupFiles: [],
    };
  },

  async buildResumeLaunch(job: RunnerJobInput, recordedSessionId: string): Promise<AdapterLaunch> {
    checkJob(job);
    refuseNative(
      job.recipe.native,
      "opencode",
      "merging flat keys into the generated config could widen permission controls",
    );
    if (recordedSessionId.length === 0) {
      throw new AdapterError("invalid-resume", "resume needs the recorded runner session id");
    }
    await mkdir(job.attemptDir, { recursive: true });
    const configPath = await writeOpencodeConfig({
      bridge: job.mcpBridge,
      sessionFile: job.sessionFile,
      attemptDir: job.attemptDir,
    });
    // Verified `opencode run --session` shape: the recorded
    // session id continues with the same standalone server,
    // model, MCP attachment and permission enforcement.
    return {
      file: "opencode",
      args: [
        "run",
        "--standalone",
        "--format",
        "json",
        "--model",
        job.recipe.model,
        "--session",
        recordedSessionId,
        job.prompt,
      ],
      cwd: job.snapshotDir,
      env: { [SESSION_FILE_ENV]: job.sessionFile, [OPENCODE_CONFIG_ENV]: configPath },
      stdin: "",
      cleanupFiles: [],
    };
  },

  parseResult(outcome: RawOutcome): RunnerResult {
    return parseHeadlessResult(outcome, scanOpencodeErrorEvent(outcome.stdout));
  },
};

/**
 * Select one implemented adapter. All four frozen runner ids
 * resolve here; anything else refuses without a fallback.
 */
export function adapterFor(runner: string): RunnerAdapter {
  switch (runner) {
    case codexAdapter.id:
      return codexAdapter;
    case museAdapter.id:
      return museAdapter;
    case claudeAdapter.id:
      return claudeAdapter;
    case opencodeAdapter.id:
      return opencodeAdapter;
    default:
      break;
  }
  throw new AdapterError(
    "unknown-adapter",
    `runner \`${runner}\` has no adapter; supported runners: codex, muse, claude-code, opencode`,
  );
}
