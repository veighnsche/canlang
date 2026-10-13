/**
 * BGI-05 MCP host tests: checked context without paths, multi-output
 * batch submission to host-owned candidates, every refusal shape,
 * fencing, completion tracking, and the no-promotion boundary.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { MCP_CONTEXT_TOOL, MCP_SUBMIT_TOOL, McpError, type AllowedTarget } from "./protocol.js";
import {
  BRIDGE_ARGV_FLAG,
  SUBMISSION_FILE,
  createMcpSession,
  defaultMcpBridge,
  openMcpSessionFromBinding,
  serveMcpBridgeStdio,
  toolHandlers,
  type McpSession,
} from "./mcp.js";

const FIXED_NOW = 1798765432100;

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "can-bgi05-mcp-"));
}

function targets(): AllowedTarget[] {
  return [
    { handle: "h-style", role: "style", kind: "style", filename: "style.css" },
    { handle: "h-server", role: "server", kind: "view", filename: "server.js" },
    { handle: "h-asset", role: "asset", kind: "view", filename: "asset.bin" },
  ];
}

async function openSession(root: string, allowed: AllowedTarget[] = targets()): Promise<McpSession> {
  return createMcpSession({
    session: "sess-1",
    attempt: "att-1",
    source_digest: "digest-1",
    allowed,
    candidateRoot: join(root, "candidates"),
    now: () => FIXED_NOW,
  });
}

async function mcpCodeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof McpError);
    return error.code;
  }
  assert.fail("expected an McpError");
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("context serves immutable checked context with no physical paths", async () => {
  const root = await freshRoot();
  const session = await openSession(root);
  const context = session.context();
  assert.equal(context.session, "sess-1");
  assert.equal(context.attempt, "att-1");
  assert.equal(context.source_digest, "digest-1");
  assert.deepEqual(
    context.allowed.map((target) => target.handle),
    ["h-style", "h-server", "h-asset"],
  );
  assert.ok(!JSON.stringify(context).includes(root));
  assert.ok(!JSON.stringify(context).includes("candidates"));
  context.allowed[0]!.handle = "mutated";
  assert.equal(session.context().allowed[0]!.handle, "h-style");
});

test("one job submits multiple permitted outputs without source names", async () => {
  const root = await freshRoot();
  const session = await openSession(root);
  const report = await session.submit("sess-1", [
    { target: "h-style", role: "style", content_text: ".a{color:red}" },
    { target: "h-server", role: "server", content_text: "export const x = 1;" },
  ]);
  assert.equal(report.accepted.length, 2);
  assert.deepEqual(
    report.accepted.map((entry) => entry.handle),
    ["h-style", "h-server"],
  );
  assert.equal(report.complete, false);
  assert.deepEqual(report.remaining, ["h-asset"]);
  const css = await readFile(join(root, "candidates", "h-style", "style.css"), "utf8");
  assert.equal(css, ".a{color:red}");
  const js = await readFile(join(root, "candidates", "h-server", "server.js"), "utf8");
  assert.equal(js, "export const x = 1;");
  const meta = JSON.parse(
    await readFile(join(root, "candidates", "h-style", SUBMISSION_FILE), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(meta["handle"], "h-style");
  assert.equal(meta["role"], "style");
  assert.equal(meta["sha256"], sha(".a{color:red}"));
  assert.equal(meta["session"], "sess-1");
  assert.equal(meta["attempt"], "att-1");
  assert.equal(meta["submitted_at"], new Date(FIXED_NOW).toISOString());
  const final = await session.submit("sess-1", [
    { target: "h-asset", role: "asset", content_base64: Buffer.from("PNG", "utf8").toString("base64") },
  ]);
  assert.equal(final.complete, true);
  assert.deepEqual(final.remaining, []);
  const asset = await readFile(join(root, "candidates", "h-asset", "asset.bin"), "utf8");
  assert.equal(asset, "PNG");
});

test("invalid targets, roles, paths, content, and sessions refuse", async () => {
  const root = await freshRoot();
  const session = await openSession(root);
  assert.equal(
    await mcpCodeOf(session.submit("sess-1", [{ target: "nope", role: "style", content_text: "x" }])),
    "unknown-target",
  );
  assert.equal(
    await mcpCodeOf(
      session.submit("sess-1", [{ target: "h-style", role: "server", content_text: "x" }]),
    ),
    "role-mismatch",
  );
  assert.equal(
    await mcpCodeOf(
      session.submit("sess-1", [{ target: "../escape", role: "style", content_text: "x" }]),
    ),
    "arbitrary-path",
  );
  assert.equal(await mcpCodeOf(session.submit("sess-1", [])), "empty-batch");
  assert.equal(
    await mcpCodeOf(
      session.submit("sess-1", [
        { target: "h-style", role: "style", content_text: "x", content_base64: "eA==" },
      ]),
    ),
    "malformed-content",
  );
  assert.equal(
    await mcpCodeOf(session.submit("sess-1", [{ target: "h-style", role: "style" }])),
    "malformed-content",
  );
  assert.equal(
    await mcpCodeOf(
      session.submit("sess-1", [{ target: "h-style", role: "style", content_text: "" }]),
    ),
    "malformed-content",
  );
  assert.equal(
    await mcpCodeOf(
      session.submit("sess-1", [{ target: "h-asset", role: "asset", content_base64: "!!!" }]),
    ),
    "malformed-content",
  );
  assert.equal(
    await mcpCodeOf(
      session.submit("sess-1", [
        { target: "h-style", role: "style", content_text: "a" },
        { target: "h-style", role: "style", content_text: "b" },
      ]),
    ),
    "duplicate-target",
  );
  assert.equal(
    await mcpCodeOf(session.submit("stale", [{ target: "h-style", role: "style", content_text: "x" }])),
    "stale-session",
  );
});

test("refusals change no current files and write no candidates", async () => {
  const root = await freshRoot();
  const current = join(root, "current");
  await mkdir(current, { recursive: true });
  await writeFile(join(current, "style.css"), "old");
  const session = await openSession(root);
  await assert.rejects(
    session.submit("sess-1", [{ target: "h-style", role: "nope", content_text: "new" }]),
  );
  await assert.rejects(
    session.submit("sess-1", [
      { target: "h-style", role: "style", content_text: "good" },
      { target: "missing", role: "style", content_text: "bad" },
    ]),
  );
  assert.equal(await readFile(join(current, "style.css"), "utf8"), "old");
  assert.deepEqual(await readdir(join(root, "candidates")), []);
});

test("cross-batch resubmission refuses even with identical content", async () => {
  const root = await freshRoot();
  const session = await openSession(root);
  await session.submit("sess-1", [{ target: "h-style", role: "style", content_text: "once" }]);
  assert.equal(
    await mcpCodeOf(session.submit("sess-1", [{ target: "h-style", role: "style", content_text: "once" }])),
    "conflicting-submission",
  );
  assert.equal(await readFile(join(root, "candidates", "h-style", "style.css"), "utf8"), "once");
});

test("cancelled and superseded sessions refuse late submissions", async () => {
  const root = await freshRoot();
  const cancelled = await openSession(root);
  cancelled.cancel("operator cancel");
  assert.equal(cancelled.state, "cancelled");
  assert.equal(
    await mcpCodeOf(cancelled.submit("sess-1", [{ target: "h-style", role: "style", content_text: "x" }])),
    "session-cancelled",
  );
  const fenced = await createMcpSession({
    session: "sess-2",
    attempt: "att-2",
    source_digest: "digest-1",
    allowed: targets(),
    candidateRoot: join(root, "candidates-2"),
  });
  fenced.supersede("reset");
  assert.equal(fenced.state, "superseded");
  assert.equal(
    await mcpCodeOf(fenced.submit("sess-2", [{ target: "h-style", role: "style", content_text: "x" }])),
    "session-superseded",
  );
});

test("completion tracks a required subset of issued handles", async () => {
  const root = await freshRoot();
  const session = await createMcpSession({
    session: "sess-1",
    attempt: "att-1",
    source_digest: "digest-1",
    allowed: targets(),
    candidateRoot: join(root, "candidates"),
    required: ["h-style"],
  });
  assert.deepEqual(session.completion(), {
    complete: false,
    submitted: [],
    required: ["h-style"],
    remaining: ["h-style"],
  });
  const report = await session.submit("sess-1", [
    { target: "h-style", role: "style", content_text: "x" },
  ]);
  assert.equal(report.complete, true);
  assert.deepEqual(session.completion().submitted, ["h-style"]);
});

test("a recreated session over one attempt shares prior submissions", async () => {
  const root = await freshRoot();
  const first = await openSession(root);
  await first.submit("sess-1", [{ target: "h-style", role: "style", content_text: "kept" }]);
  const second = await openSession(root);
  assert.deepEqual(second.completion().submitted, ["h-style"]);
  assert.equal(
    await mcpCodeOf(second.submit("sess-1", [{ target: "h-style", role: "style", content_text: "redo" }])),
    "conflicting-submission",
  );
  const report = await second.submit("sess-1", [
    { target: "h-server", role: "server", content_text: "more" },
  ]);
  assert.deepEqual(report.remaining, ["h-asset"]);
});

test("stray files beside host metadata are never collected as output", async () => {
  const root = await freshRoot();
  const first = await openSession(root);
  await first.submit("sess-1", [{ target: "h-style", role: "style", content_text: "host" }]);
  await writeFile(join(root, "candidates", "agent-dropping.txt"), "not output");
  await mkdir(join(root, "candidates", "h-evil"), { recursive: true });
  await writeFile(join(root, "candidates", "h-evil", "style.css"), "not output");
  const second = await openSession(root);
  assert.deepEqual(second.completion().submitted, ["h-style"]);
});

test("invalid issuance refuses at creation", async () => {
  const root = await freshRoot();
  const base = {
    session: "s",
    attempt: "a",
    source_digest: "d",
    allowed: targets(),
    candidateRoot: join(root, "candidates"),
  };
  await assert.rejects(createMcpSession({ ...base, session: "" }), /invalid-session/);
  await assert.rejects(createMcpSession({ ...base, allowed: [] }), /invalid-session/);
  await assert.rejects(
    createMcpSession({ ...base, allowed: [...targets(), targets()[0]!] }),
    /invalid-session/,
  );
  await assert.rejects(
    createMcpSession({
      ...base,
      allowed: [{ handle: "bad handle", role: "style", kind: "style", filename: "style.css" }],
    }),
    /invalid-session/,
  );
  await assert.rejects(
    createMcpSession({
      ...base,
      allowed: [{ handle: "h", role: "style", kind: "style", filename: "../evil.css" }],
    }),
    /invalid-session/,
  );
  await assert.rejects(createMcpSession({ ...base, required: ["missing"] }), /invalid-session/);
});

test("tool handlers dispatch by the frozen BGI-03 tool names", async () => {
  const root = await freshRoot();
  const session = await openSession(root);
  const handlers = toolHandlers(session);
  assert.equal(MCP_CONTEXT_TOOL, "generation_context");
  assert.equal(MCP_SUBMIT_TOOL, "generation_submit");
  assert.equal(handlers[MCP_CONTEXT_TOOL]().session, "sess-1");
  const report = await handlers[MCP_SUBMIT_TOOL]({
    session: "sess-1",
    batch: [{ target: "h-style", role: "style", content_text: "x" }],
  });
  assert.equal(report.accepted.length, 1);
  await assert.rejects(handlers[MCP_SUBMIT_TOOL]({ session: "sess-1", batch: "nope" as never }), /malformed-content/);
});

test("the session exposes no accept, promote, or qualify member", async () => {
  const root = await freshRoot();
  const session = await openSession(root);
  await session.submit("sess-1", [{ target: "h-style", role: "style", content_text: "x" }]);
  for (const name of ["accept", "promote", "qualify", "commit", "adopt"]) {
    assert.equal(name in session, false);
  }
});

/** One host-written attempt dir a bridge serves: binding plus capture. */
async function writeBridgeAttempt(root: string): Promise<string> {
  const attemptDir = join(root, "attempt");
  await mkdir(attemptDir, { recursive: true });
  await writeFile(
    join(attemptDir, "session.json"),
    JSON.stringify({
      session: "sess-1",
      attempt: "att-1",
      source_digest: "digest-1",
      fence: 0,
      allowed: 2,
      created_at: new Date(FIXED_NOW).toISOString(),
    }),
  );
  await writeFile(
    join(attemptDir, "capture.json"),
    JSON.stringify({
      units: [{ unit_id: "u1", kind: "style" }],
      handles: {
        "u1-style": { unit: "u1", role: "style", filename: "style.css", saved: "style.css", required: true },
        "u1-asset": { unit: "u1", role: "asset", filename: "asset.bin", saved: "asset.bin", required: false },
      },
    }),
  );
  return attemptDir;
}

test("the stdio bridge serves the live session with bounded refusals", async () => {
  const root = await freshRoot();
  const attemptDir = await writeBridgeAttempt(root);
  const bound = await openMcpSessionFromBinding(join(attemptDir, "session.json"), () => FIXED_NOW);
  assert.equal(bound.session.id, "sess-1");
  assert.equal(bound.attemptDir, attemptDir);
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  const served = serveMcpBridgeStdio({ session: bound.session, input, output });
  const send = (value: unknown): void => {
    input.write(`${JSON.stringify(value)}\n`);
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "generation_context", arguments: {} } });
  send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "generation_submit",
      arguments: { session: "sess-1", batch: [{ target: "u1-style", role: "style", content_text: ".live{}" }] },
    },
  });
  // Duplicate, unknown-target, unknown-method, and garbage lines refuse loudly.
  send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "generation_submit",
      arguments: { session: "sess-1", batch: [{ target: "u1-style", role: "style", content_text: "again" }] },
    },
  });
  send({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "generation_submit",
      arguments: { session: "sess-1", batch: [{ target: "../escape", role: "style", content_text: "x" }] },
    },
  });
  send({ jsonrpc: "2.0", id: 7, method: "nope/not-a-method" });
  input.write("this is not json\n");
  send({ jsonrpc: "2.0", id: 8, method: "ping" });
  input.end();
  assert.equal(await served, 0);
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  // Every request got exactly one response; the notification got none.
  assert.equal(lines.length, 9);
  const byId = new Map(lines.map((line) => {
    const parsed = JSON.parse(line) as { id: number | null };
    return [parsed.id, JSON.parse(line) as Record<string, unknown>];
  }));
  const resultOf = (id: number): Record<string, unknown> =>
    (byId.get(id)?.["result"] ?? {}) as Record<string, unknown>;
  assert.equal((resultOf(1)["serverInfo"] as { name: string }).name, "can-generation");
  assert.deepEqual(
    ((resultOf(2)["tools"] ?? []) as { name: string }[]).map((tool) => tool.name).sort(),
    ["generation_context", "generation_submit"],
  );
  const context = JSON.parse(
    ((resultOf(3)["content"] ?? []) as { text: string }[])[0]?.text ?? "{}",
  ) as { allowed: { handle: string }[] };
  assert.deepEqual(context.allowed.map((target) => target.handle).sort(), ["u1-asset", "u1-style"]);
  const report = JSON.parse(
    ((resultOf(4)["content"] ?? []) as { text: string }[])[0]?.text ?? "{}",
  ) as { complete: boolean; remaining: string[] };
  assert.equal(report.complete, true);
  assert.deepEqual(report.remaining, []);
  assert.equal(resultOf(5)["isError"], true);
  assert.equal(resultOf(6)["isError"], true);
  assert.equal((byId.get(7)?.["error"] as { code: number }).code, -32601);
  assert.equal((byId.get(null)?.["error"] as { code: number }).code, -32700);
  assert.deepEqual(resultOf(8), {});
  // The host placed the accepted bytes; refusals wrote nothing else.
  assert.equal(await readFile(join(attemptDir, "candidates", "u1-style", "style.css"), "utf8"), ".live{}");
});

test("a fenced bridge refuses calls while the binding opener refuses drift", async () => {
  const root = await freshRoot();
  const attemptDir = await writeBridgeAttempt(root);
  const bound = await openMcpSessionFromBinding(join(attemptDir, "session.json"));
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  const served = serveMcpBridgeStdio({
    session: bound.session,
    input,
    output,
    fenceGuard: async () => false,
  });
  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "generation_context", arguments: {} } })}\n`,
  );
  input.end();
  assert.equal(await served, 0);
  const response = JSON.parse(text.trim()) as { error: { code: number; message: string } };
  assert.equal(response.error.code, -32000);
  assert.match(response.error.message, /fence moved/);
  // The opener refuses a moved fence, a missing binding, and bad issuance.
  await writeFile(join(attemptDir, "fence.json"), JSON.stringify({ generation: 3, reason: "reset", at: "t" }));
  await assert.rejects(openMcpSessionFromBinding(join(attemptDir, "session.json")), /session-superseded/);
  await assert.rejects(openMcpSessionFromBinding(join(root, "missing", "session.json")), /invalid-session/);
  const brokenDir = join(root, "broken");
  await mkdir(brokenDir, { recursive: true });
  await writeFile(
    join(brokenDir, "session.json"),
    JSON.stringify({ session: "s", attempt: "a", source_digest: "d", fence: 0, allowed: 1, created_at: "t" }),
  );
  await writeFile(join(brokenDir, "capture.json"), JSON.stringify({ units: [], handles: { "h": { unit: "u9" } } }));
  await assert.rejects(openMcpSessionFromBinding(join(brokenDir, "session.json")), /invalid-session/);
});

test("the bridge entry runs as a spawned process over the default command", async () => {
  const bridge = defaultMcpBridge();
  assert.equal(bridge.command, process.execPath);
  assert.deepEqual(bridge.args, [fileURLToPath(import.meta.resolve("./mcp.js")), BRIDGE_ARGV_FLAG]);
  const root = await freshRoot();
  const attemptDir = await writeBridgeAttempt(root);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve("./mcp.js")), BRIDGE_ARGV_FLAG], {
    env: { ...process.env, CAN_GENERATION_SESSION_FILE: join(attemptDir, "session.json") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const responses: unknown[] = [];
  const waitFor = async (count: number): Promise<void> => {
    const start = Date.now();
    for (;;) {
      const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
      if (lines.length >= count) {
        responses.push(...lines.slice(responses.length).map((line) => JSON.parse(line) as unknown));
        return;
      }
      if (Date.now() - start > 10000) throw new Error(`timed out waiting for bridge output: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const send = (value: unknown): void => {
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  await waitFor(1);
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "generation_context", arguments: {} } });
  await waitFor(2);
  const context = JSON.parse(
    (((responses[1] as { result: { content: { text: string }[] } }).result.content)[0]?.text ?? "{}") as string,
  ) as { session: string; allowed: { handle: string; role: string }[] };
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "generation_submit",
      arguments: {
        session: context.session,
        batch: context.allowed.map((target) => ({
          target: target.handle,
          role: target.role,
          ...(target.role === "asset"
            ? { content_base64: Buffer.from("PNG").toString("base64") }
            : { content_text: ".spawned{}" }),
        })),
      },
    },
  });
  await waitFor(3);
  child.stdin.end();
  const code = await new Promise<number>((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.equal(stderr, "");
  const report = JSON.parse(
    (((responses[2] as { result: { content: { text: string }[] } }).result.content)[0]?.text ?? "{}") as string,
  ) as { complete: boolean };
  assert.equal(report.complete, true);
  assert.equal(await readFile(join(attemptDir, "candidates", "u1-style", "style.css"), "utf8"), ".spawned{}");
  // Without a binding the entry exits loudly instead of serving.
  const missing = spawn(process.execPath, [fileURLToPath(import.meta.resolve("./mcp.js")), BRIDGE_ARGV_FLAG], {
    env: { ...process.env, CAN_GENERATION_SESSION_FILE: join(root, "missing", "session.json") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let missingStderr = "";
  missing.stderr.setEncoding("utf8");
  missing.stderr.on("data", (chunk: string) => {
    missingStderr += chunk;
  });
  missing.stdin.end();
  const missingCode = await new Promise<number>((resolve) => missing.on("close", resolve));
  assert.equal(missingCode, 1);
  assert.match(missingStderr, /session binding/);
});
