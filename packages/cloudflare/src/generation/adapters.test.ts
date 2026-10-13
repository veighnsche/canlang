/**
 * Adapter tests (BGI-05 interface plus BGI-06): the one adapter
 * interface, verified argv/MCP attachment per runner, restriction
 * controls that cannot relax, unsupported-capability diagnosis, and
 * structured-result parsing into ok/known-failure/unknown.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import type { EffectiveRecipe } from "./config.js";
import { MCP_CONTEXT_TOOL, MCP_SUBMIT_TOOL, adapterCapabilities } from "./protocol.js";
import {
  CLAUDE_MCP_FILE,
  CODEX_MCP_SERVER_NAME,
  GENERATION_MCP_SERVER_NAME,
  OPENCODE_CONFIG_ENV,
  OPENCODE_CONFIG_FILE,
  PROMPT_FILE,
  SESSION_FILE_ENV,
  AdapterError,
  adapterFor,
  claudeAdapter,
  codexAdapter,
  museAdapter,
  opencodeAdapter,
  probeExecutable,
  removeCodexMcpProfile,
  writeClaudeMcpConfig,
  writeCodexMcpProfile,
  writeOpencodeConfig,
  type RunnerJobInput,
} from "./adapters.js";

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "can-bgi05-adapter-"));
}

function recipe(overrides: Partial<EffectiveRecipe> = {}): EffectiveRecipe {
  return {
    runner: "codex",
    model: "test-model",
    max_attempts: 1,
    timeout_seconds: 600,
    native: {},
    origins: {},
    settings: null,
    recipe_source: "test",
    ...overrides,
  };
}

function job(root: string, overrides: Partial<RunnerJobInput> = {}): RunnerJobInput {
  return {
    recipe: recipe(),
    snapshotDir: join(root, "snapshot"),
    attemptDir: join(root, "attempt"),
    sessionFile: join(root, "attempt", "session.json"),
    prompt: "Generate the style.",
    outputSchema: JSON.stringify({ type: "object" }),
    mcpBridge: null,
    codexHome: join(root, "codex-home"),
    profileName: "can-gen-test",
    ...overrides,
  };
}

test("codex launch argv matches the verified exec shape", async () => {
  const root = await freshRoot();
  const launch = await codexAdapter.buildLaunch(job(root));
  assert.equal(launch.file, "codex");
  assert.deepEqual(launch.args, [
    "exec",
    "--json",
    "--color",
    "never",
    "-s",
    "read-only",
    "-C",
    join(root, "snapshot"),
    "-m",
    "test-model",
    "--output-schema",
    join(root, "attempt", "output-schema.json"),
    "-",
  ]);
  assert.equal(launch.cwd, join(root, "attempt"));
  assert.equal(launch.stdin, "Generate the style.");
  assert.deepEqual(launch.env, { [SESSION_FILE_ENV]: join(root, "attempt", "session.json") });
  assert.deepEqual(launch.cleanupFiles, []);
  const schema = JSON.parse(await readFile(join(root, "attempt", "output-schema.json"), "utf8"));
  assert.deepEqual(schema, { type: "object" });
});

test("restriction flags are always present and never bypassable", async () => {
  const root = await freshRoot();
  const launch = await codexAdapter.buildLaunch(job(root));
  assert.ok(launch.args.includes("-s"));
  assert.equal(launch.args[launch.args.indexOf("-s") + 1], "read-only");
  for (const forbidden of [
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--approve-for-me",
    "--add-dir",
    "--worktree",
  ]) {
    assert.equal(launch.args.includes(forbidden), false);
  }
  // No job field relaxes the sandbox: native options only add `-c`.
  const native = await codexAdapter.buildLaunch(
    job(root, { recipe: recipe({ native: { "sandbox_mode": "x" } }) }),
  );
  assert.ok(native.args.includes("-s"));
  assert.equal(native.args[native.args.indexOf("-s") + 1], "read-only");
  assert.ok(native.args.includes("-c"));
});

test("native options render as preflight-accepted -c pairs", async () => {
  const root = await freshRoot();
  const launch = await codexAdapter.buildLaunch(
    job(root, { recipe: recipe({ native: { tries: 2, strict: true, label: "a b" } }) }),
  );
  const pairs: string[] = [];
  for (let i = 0; i < launch.args.length; i += 1) {
    if (launch.args[i] === "-c") pairs.push(launch.args[i + 1] as string);
  }
  assert.deepEqual(pairs.sort(), ['label="a b"', "strict=true", "tries=2"]);
});

test("invalid jobs refuse before any launch", async () => {
  const root = await freshRoot();
  await assert.rejects(codexAdapter.buildLaunch(job(root, { prompt: "" })), AdapterError);
  await assert.rejects(codexAdapter.buildLaunch(job(root, { outputSchema: "{nope" })), AdapterError);
  await assert.rejects(codexAdapter.buildLaunch(job(root, { sessionFile: "" })), AdapterError);
});

test("a qualified bridge attaches a bounded MCP profile layer", async () => {
  const root = await freshRoot();
  const bridge = { command: "/opt/can/mcp-bridge", args: ["--stdio"] as const };
  const launch = await codexAdapter.buildLaunch(
    job(root, { mcpBridge: { command: bridge.command, args: [...bridge.args] } }),
  );
  assert.deepEqual(launch.args.slice(-3), ["-p", "can-gen-test", "-"]);
  assert.equal(launch.cleanupFiles.length, 1);
  const profile = launch.cleanupFiles[0] as string;
  assert.equal(profile, join(root, "codex-home", "can-gen-test.config.toml"));
  const text = await readFile(profile, "utf8");
  assert.ok(text.includes(`[mcp_servers.${JSON.stringify(CODEX_MCP_SERVER_NAME)}]`));
  assert.ok(text.includes('command = "/opt/can/mcp-bridge"'));
  assert.ok(text.includes(`${SESSION_FILE_ENV} = `));
  await removeCodexMcpProfile(profile);
  await assert.rejects(readFile(profile, "utf8"));
  await removeCodexMcpProfile(profile);
});

test("profile names cannot traverse into other config files", async () => {
  const root = await freshRoot();
  await assert.rejects(
    writeCodexMcpProfile({
      codexHome: join(root, "codex-home"),
      profileName: "../escape",
      bridge: { command: "/bin/true", args: [] },
      sessionFile: join(root, "session.json"),
      attemptDir: join(root, "attempt"),
    }),
    AdapterError,
  );
});

test("resume argv keeps the recorded root and sandbox", async () => {
  const root = await freshRoot();
  const launch = await codexAdapter.buildResumeLaunch(job(root), "thread-123");
  assert.deepEqual(launch.args.slice(0, 3), ["exec", "resume", "thread-123"]);
  assert.equal(launch.args.includes("-C"), false);
  assert.equal(launch.args.includes("-s"), false);
  assert.ok(launch.args.includes("--json"));
  assert.ok(launch.args.includes("--output-schema"));
  assert.equal(launch.args[launch.args.length - 1], "-");
  await assert.rejects(codexAdapter.buildResumeLaunch(job(root), ""), AdapterError);
});

test("structured results parse into ok, known failure, and unknown", async () => {
  assert.deepEqual(
    codexAdapter.parseResult({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
    { kind: "ok", detail: "runner exited 0" },
  );
  const known = codexAdapter.parseResult({
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "model exploded",
    timedOut: false,
  });
  assert.equal(known.kind, "known-failure");
  assert.equal(known.kind === "known-failure" && known.retryable, true);
  assert.ok(known.kind === "known-failure" && known.detail.includes("model exploded"));
  const reported = codexAdapter.parseResult({
    exitCode: 1,
    signal: null,
    stdout: '{"type":"error","message":"quota spent"}\n',
    stderr: "noise",
    timedOut: false,
  });
  assert.ok(reported.kind === "known-failure" && reported.detail.includes("quota spent"));
  const timeout = codexAdapter.parseResult({
    exitCode: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
    timedOut: true,
  });
  assert.equal(timeout.kind, "unknown");
  const killed = codexAdapter.parseResult({
    exitCode: null,
    signal: "SIGKILL",
    stdout: "",
    stderr: "",
    timedOut: false,
  });
  assert.equal(killed.kind, "unknown");
  const missing = codexAdapter.parseResult({
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    spawnError: "spawn codex ENOENT",
  });
  assert.equal(missing.kind, "known-failure");
  assert.equal(missing.kind === "known-failure" && missing.retryable, false);
});

test("executable probing reports every tried name", async () => {
  const root = await freshRoot();
  const bin = join(root, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bin, { recursive: true });
  const fake = join(bin, "fakerunner");
  await writeFile(fake, "#!/bin/sh\nexit 0\n");
  await chmod(fake, 0o755);
  const found = await probeExecutable(["fakerunner"], [bin, "/nonexistent"].join(delimiter));
  assert.equal(found, fake);
  await assert.rejects(probeExecutable(["no-such-runner"], bin), /tried .*no-such-runner/);
});

test("all four required runners resolve; anything else refuses", () => {
  assert.equal(adapterFor("codex"), codexAdapter);
  assert.equal(adapterFor("muse"), museAdapter);
  assert.equal(adapterFor("claude-code"), claudeAdapter);
  assert.equal(adapterFor("opencode"), opencodeAdapter);
  for (const runner of ["other", "", "Codex", "claude"]) {
    assert.throws(() => adapterFor(runner), AdapterError);
  }
});

test("probe binaries match the frozen protocol table per runner", () => {
  for (const adapter of [codexAdapter, museAdapter, claudeAdapter, opencodeAdapter]) {
    const advertised = adapterCapabilities(adapter.id);
    assert.ok(advertised, `protocol table advertises ${adapter.id}`);
    assert.deepEqual(
      [...adapter.probeBinaries()],
      [...(advertised as NonNullable<typeof advertised>).probe_binaries],
    );
  }
  assert.deepEqual([...museAdapter.probeBinaries()], ["muse"]);
  assert.deepEqual([...claudeAdapter.probeBinaries()], ["claude", "claude-code"]);
  assert.deepEqual([...opencodeAdapter.probeBinaries()], ["opencode"]);
});

test("muse launch argv matches the verified exec shape", async () => {
  const root = await freshRoot();
  const launch = await museAdapter.buildLaunch(job(root));
  assert.equal(launch.file, "muse");
  assert.deepEqual(launch.args, [
    "exec",
    "--json",
    "--model",
    "test-model",
    "--output-schema",
    join(root, "attempt", "output-schema.json"),
    "--workspace",
    join(root, "snapshot"),
    "--prompt-file",
    join(root, "attempt", PROMPT_FILE),
    "--disable-approval",
    "--disable-write",
    "--disable-shell",
    "--disable-web-tools",
  ]);
  assert.equal(launch.cwd, join(root, "attempt"));
  assert.equal(launch.stdin, "");
  assert.deepEqual(launch.env, { [SESSION_FILE_ENV]: join(root, "attempt", "session.json") });
  assert.deepEqual(launch.cleanupFiles, []);
  assert.equal(await readFile(join(root, "attempt", PROMPT_FILE), "utf8"), "Generate the style.");
  const schema = JSON.parse(await readFile(join(root, "attempt", "output-schema.json"), "utf8"));
  assert.deepEqual(schema, { type: "object" });
});

test("muse restrictions cannot relax and widening flags never appear", async () => {
  const root = await freshRoot();
  const launch = await museAdapter.buildLaunch(job(root));
  for (const required of ["--disable-approval", "--disable-write", "--disable-shell", "--disable-web-tools"]) {
    assert.ok(launch.args.includes(required), `argv carries ${required}`);
  }
  for (const forbidden of [
    "--yolo",
    "--disable-sandbox",
    "--trust-workspace",
    "--allow-workspace-switch",
    "--provider",
    "--session-id",
  ]) {
    assert.equal(launch.args.includes(forbidden), false, `argv never carries ${forbidden}`);
  }
});

test("muse native options render as -c JSON pairs", async () => {
  const root = await freshRoot();
  const launch = await museAdapter.buildLaunch(
    job(root, { recipe: recipe({ native: { tries: 2, strict: true, label: "a b" } }) }),
  );
  const pairs: string[] = [];
  for (let i = 0; i < launch.args.length; i += 1) {
    if (launch.args[i] === "-c") pairs.push(launch.args[i + 1] as string);
  }
  assert.deepEqual(pairs.sort(), ['label="a b"', "strict=true", "tries=2"]);
});

test("muse attaches MCP through one per-server -c entry with env indirection", async () => {
  const root = await freshRoot();
  const launch = await museAdapter.buildLaunch(
    job(root, { mcpBridge: { command: "/opt/can/mcp-bridge", args: ["--stdio"] } }),
  );
  const flag = launch.args.indexOf("-c");
  assert.ok(flag >= 0);
  const setting = launch.args[flag + 1] as string;
  assert.ok(setting.startsWith(`mcpServers.${GENERATION_MCP_SERVER_NAME}=`));
  const entry = JSON.parse(setting.slice(setting.indexOf("=") + 1)) as Record<string, unknown>;
  assert.deepEqual(entry, {
    command: "/opt/can/mcp-bridge",
    args: ["--stdio"],
    env: { [SESSION_FILE_ENV]: `\${${SESSION_FILE_ENV}}` },
  });
  assert.equal(launch.env[SESSION_FILE_ENV], join(root, "attempt", "session.json"));
  const bare = await museAdapter.buildLaunch(job(root));
  assert.equal(bare.args.includes("-c"), false);
});

test("muse resume diagnoses instead of faking continuity", async () => {
  const root = await freshRoot();
  await assert.rejects(
    museAdapter.buildResumeLaunch(job(root), "01a13434-0000-7000-8000-000000000003"),
    /no headless recorded-session resume/,
  );
  await assert.rejects(museAdapter.buildResumeLaunch(job(root, { prompt: "" }), "x"), AdapterError);
});

test("muse failures report the terminal reason", async () => {
  assert.deepEqual(
    museAdapter.parseResult({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
    { kind: "ok", detail: "runner exited 0" },
  );
  const failed = museAdapter.parseResult({
    exitCode: 1,
    signal: null,
    stdout: '{"payload_type":"run.terminal.failed","payload":{"reason":"Required MCP server `can-generation` failed during startup"}}\n',
    stderr: "",
    timedOut: false,
  });
  assert.equal(failed.kind, "known-failure");
  assert.ok(failed.kind === "known-failure" && failed.detail.includes("Required MCP server"));
  const unknown = museAdapter.parseResult({
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: true,
  });
  assert.equal(unknown.kind, "unknown");
});

test("claude launch argv matches the verified print shape", async () => {
  const root = await freshRoot();
  const launch = await claudeAdapter.buildLaunch(job(root));
  assert.equal(launch.file, "claude");
  assert.deepEqual(launch.args, [
    "-p",
    "Generate the style.",
    "--model",
    "test-model",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify({ type: "object" }),
    "--tools",
    "Read,Glob,Grep",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--restricted",
    "--strict-mcp-config",
  ]);
  assert.equal(launch.cwd, join(root, "snapshot"));
  assert.equal(launch.stdin, "");
  assert.deepEqual(launch.env, { [SESSION_FILE_ENV]: join(root, "attempt", "session.json") });
  assert.deepEqual(launch.cleanupFiles, []);
});

test("claude restrictions cannot relax and widening flags never appear", async () => {
  const root = await freshRoot();
  const launch = await claudeAdapter.buildLaunch(
    job(root, { mcpBridge: { command: "/opt/can/mcp-bridge", args: ["--stdio"] } }),
  );
  assert.equal(launch.args[launch.args.indexOf("--tools") + 1], "Read,Glob,Grep");
  assert.equal(launch.args[launch.args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(launch.args[launch.args.indexOf("--permission-prompts") + 1], "none");
  assert.ok(launch.args.includes("--restricted"));
  assert.ok(launch.args.includes("--strict-mcp-config"));
  for (const forbidden of [
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--add-dir",
    "--agent",
    "--ide",
  ]) {
    assert.equal(launch.args.includes(forbidden), false, `argv never carries ${forbidden}`);
  }
  assert.ok(!launch.args.some((arg) => arg.includes("Edit") || arg.includes("Write") || arg.includes("Bash")));
});

test("claude attaches MCP through a strict config plus named tool allows", async () => {
  const root = await freshRoot();
  const launch = await claudeAdapter.buildLaunch(
    job(root, { mcpBridge: { command: "/opt/can/mcp-bridge", args: ["--stdio"] } }),
  );
  const mcpPath = launch.args[launch.args.indexOf("--mcp-config") + 1] as string;
  assert.equal(mcpPath, join(root, "attempt", CLAUDE_MCP_FILE));
  const config = JSON.parse(await readFile(mcpPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(config, {
    mcpServers: {
      [GENERATION_MCP_SERVER_NAME]: {
        command: "/opt/can/mcp-bridge",
        args: ["--stdio"],
        env: { [SESSION_FILE_ENV]: join(root, "attempt", "session.json") },
      },
    },
  });
  const allowed = launch.args[launch.args.indexOf("--allowedTools") + 1] as string;
  assert.equal(
    allowed,
    `mcp__${GENERATION_MCP_SERVER_NAME}__${MCP_CONTEXT_TOOL},mcp__${GENERATION_MCP_SERVER_NAME}__${MCP_SUBMIT_TOOL}`,
  );
  const bare = await claudeAdapter.buildLaunch(job(root));
  assert.ok(bare.args.includes("--strict-mcp-config"));
  assert.equal(bare.args.includes("--mcp-config"), false);
  assert.equal(bare.args.includes("--allowedTools"), false);
});

test("claude resume keeps the session id with identical controls", async () => {
  const root = await freshRoot();
  const launch = await claudeAdapter.buildResumeLaunch(job(root), "session-123");
  assert.deepEqual(launch.args.slice(0, 4), ["-p", "Generate the style.", "--resume", "session-123"]);
  assert.ok(launch.args.includes("--restricted"));
  assert.ok(launch.args.includes("--strict-mcp-config"));
  assert.equal(launch.args[launch.args.indexOf("--tools") + 1], "Read,Glob,Grep");
  await assert.rejects(claudeAdapter.buildResumeLaunch(job(root), ""), AdapterError);
});

test("claude failures report the result text", async () => {
  assert.deepEqual(
    claudeAdapter.parseResult({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
    { kind: "ok", detail: "runner exited 0" },
  );
  const failed = claudeAdapter.parseResult({
    exitCode: 1,
    signal: null,
    stdout: JSON.stringify({ type: "result", is_error: true, result: "Not logged in" }),
    stderr: "",
    timedOut: false,
  });
  assert.equal(failed.kind, "known-failure");
  assert.ok(failed.kind === "known-failure" && failed.detail.includes("Not logged in"));
  const killed = claudeAdapter.parseResult({
    exitCode: null,
    signal: "SIGKILL",
    stdout: "",
    stderr: "",
    timedOut: false,
  });
  assert.equal(killed.kind, "unknown");
});

test("claude refuses native options without a safe channel", async () => {
  const root = await freshRoot();
  await assert.rejects(
    claudeAdapter.buildLaunch(job(root, { recipe: recipe({ native: { tries: 2 } }) })),
    /documents no safe native channel/,
  );
  await assert.rejects(
    claudeAdapter.buildResumeLaunch(job(root, { recipe: recipe({ native: { tries: 2 } }) }), "s"),
    /documents no safe native channel/,
  );
});

test("opencode launch argv matches the verified run shape", async () => {
  const root = await freshRoot();
  const launch = await opencodeAdapter.buildLaunch(
    job(root, { recipe: recipe({ runner: "opencode", model: "provider/test-model" }) }),
  );
  assert.equal(launch.file, "opencode");
  assert.deepEqual(launch.args, [
    "run",
    "--standalone",
    "--format",
    "json",
    "--model",
    "provider/test-model",
    "Generate the style.",
  ]);
  assert.equal(launch.cwd, join(root, "snapshot"));
  assert.equal(launch.stdin, "");
  assert.deepEqual(launch.env, {
    [SESSION_FILE_ENV]: join(root, "attempt", "session.json"),
    [OPENCODE_CONFIG_ENV]: join(root, "attempt", OPENCODE_CONFIG_FILE),
  });
  assert.deepEqual(launch.cleanupFiles, []);
  for (const forbidden of ["--auto", "--server", "--attach", "--agent"]) {
    assert.equal(launch.args.includes(forbidden), false, `argv never carries ${forbidden}`);
  }
});

test("opencode config denies by default with read-only and MCP allows", async () => {
  const root = await freshRoot();
  const launch = await opencodeAdapter.buildLaunch(
    job(root, { mcpBridge: { command: "/opt/can/mcp-bridge", args: ["--stdio"] } }),
  );
  const configPath = launch.env[OPENCODE_CONFIG_ENV] as string;
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  const mcp = (config["mcp"] as Record<string, Record<string, unknown>>)[GENERATION_MCP_SERVER_NAME];
  assert.deepEqual(mcp, {
    type: "local",
    command: ["/opt/can/mcp-bridge", "--stdio"],
    environment: { [SESSION_FILE_ENV]: join(root, "attempt", "session.json") },
    enabled: true,
  });
  const permission = config["permission"] as Record<string, string>;
  assert.equal(permission["*"], "deny");
  for (const tool of ["read", "glob", "grep", "list"]) {
    assert.equal(permission[tool], "allow", `${tool} stays readable`);
  }
  for (const tool of [
    "edit",
    "bash",
    "task",
    "skill",
    "lsp",
    "question",
    "webfetch",
    "websearch",
    "external_directory",
    "doom_loop",
  ]) {
    assert.equal(permission[tool], "deny", `${tool} is denied`);
  }
  assert.equal(permission[`${GENERATION_MCP_SERVER_NAME}_*`], "allow");
  const agent = config["agent"] as Record<string, Record<string, unknown>>;
  const buildAgent = agent["build"] as Record<string, unknown>;
  assert.deepEqual(buildAgent["permission"], permission);
  const bare = JSON.parse(
    await readFile(
      await writeOpencodeConfig({
        bridge: null,
        sessionFile: join(root, "attempt", "session.json"),
        attemptDir: join(root, "attempt"),
      }),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal("mcp" in bare, false);
  assert.equal((bare["permission"] as Record<string, string>)["*"], "deny");
});

test("opencode resume keeps the session id with identical controls", async () => {
  const root = await freshRoot();
  const launch = await opencodeAdapter.buildResumeLaunch(job(root), "ses_abc123");
  assert.deepEqual(launch.args.slice(0, 8), [
    "run",
    "--standalone",
    "--format",
    "json",
    "--model",
    "test-model",
    "--session",
    "ses_abc123",
  ]);
  assert.equal(launch.args[launch.args.length - 1], "Generate the style.");
  assert.ok(OPENCODE_CONFIG_ENV in launch.env);
  await assert.rejects(opencodeAdapter.buildResumeLaunch(job(root), ""), AdapterError);
});

test("opencode failures report the error event message", async () => {
  assert.deepEqual(
    opencodeAdapter.parseResult({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
    { kind: "ok", detail: "runner exited 0" },
  );
  const failed = opencodeAdapter.parseResult({
    exitCode: 1,
    signal: null,
    stdout: '{"type":"error","error":{"type":"provider.no-route","message":"Model unavailable: x/y"}}\n',
    stderr: "",
    timedOut: false,
  });
  assert.equal(failed.kind, "known-failure");
  assert.ok(failed.kind === "known-failure" && failed.detail.includes("Model unavailable: x/y"));
  const missing = opencodeAdapter.parseResult({
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    spawnError: "spawn opencode ENOENT",
  });
  assert.equal(missing.kind, "known-failure");
  assert.equal(missing.kind === "known-failure" && missing.retryable, false);
});

test("opencode refuses native options without a safe channel", async () => {
  const root = await freshRoot();
  await assert.rejects(
    opencodeAdapter.buildLaunch(job(root, { recipe: recipe({ native: { tries: 2 } }) })),
    /documents no safe native channel/,
  );
  await assert.rejects(
    opencodeAdapter.buildResumeLaunch(job(root, { recipe: recipe({ native: { tries: 2 } }) }), "s"),
    /documents no safe native channel/,
  );
});

test("every adapter shares the host-owned output contract", async () => {
  const root = await freshRoot();
  for (const adapter of [codexAdapter, museAdapter, claudeAdapter, opencodeAdapter]) {
    const launch = await adapter.buildLaunch(job(root));
    assert.equal(
      launch.env[SESSION_FILE_ENV],
      join(root, "attempt", "session.json"),
      `${adapter.id} binds the host session file`,
    );
    assert.deepEqual(
      adapter.parseResult({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false }),
      { kind: "ok", detail: "runner exited 0" },
      `${adapter.id} reports a clean exit as ok only`,
    );
  }
  assert.equal(GENERATION_MCP_SERVER_NAME, CODEX_MCP_SERVER_NAME);
  assert.ok(MCP_CONTEXT_TOOL.length > 0);
  assert.ok(MCP_SUBMIT_TOOL.length > 0);
});

test("claude mcp writer stores one stdio entry in attempt scratch", async () => {
  const root = await freshRoot();
  const path = await writeClaudeMcpConfig({
    bridge: { command: "/opt/can/mcp-bridge", args: [] },
    sessionFile: join(root, "attempt", "session.json"),
    attemptDir: join(root, "attempt"),
  });
  assert.equal(path, join(root, "attempt", CLAUDE_MCP_FILE));
});
