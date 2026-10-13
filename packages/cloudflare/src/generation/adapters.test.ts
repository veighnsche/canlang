/**
 * BGI-05 adapter tests: the one adapter interface, verified Codex
 * argv/MCP attachment, restriction flags that cannot relax, and
 * structured-result parsing into ok/known-failure/unknown.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import type { EffectiveRecipe } from "./config.js";
import {
  CODEX_MCP_SERVER_NAME,
  SESSION_FILE_ENV,
  AdapterError,
  adapterFor,
  codexAdapter,
  probeExecutable,
  removeCodexMcpProfile,
  writeCodexMcpProfile,
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

test("only codex resolves; other runners belong to BGI-06", () => {
  assert.equal(adapterFor("codex"), codexAdapter);
  for (const runner of ["muse", "claude-code", "opencode", "other"]) {
    assert.throws(() => adapterFor(runner), AdapterError);
  }
});
