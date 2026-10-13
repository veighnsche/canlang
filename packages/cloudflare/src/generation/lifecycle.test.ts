/**
 * BGI-05 lifecycle tests: retry planning over the active closure,
 * refine/fresh baselines, the idempotent request ledger, fencing,
 * and bounded fake-executable runs (argv, read-only snapshot,
 * host-owned placement, retries, unknown completion, cancel/reset,
 * and recorded-session resume).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveRecipe } from "./config.js";
import { PreflightError, type AllowedTarget } from "./protocol.js";
import { createMcpSession, type McpSession } from "./mcp.js";
import {
  LifecycleError,
  advanceFence,
  buildFreshBaseline,
  buildRefineBaseline,
  buildRetryJobs,
  cancelAttempt,
  executeJob,
  extractRunnerSession,
  hashInput,
  lookupRequest,
  markSuperseded,
  readAttempt,
  readFence,
  resetAttempt,
  resumeSession,
  storeRequest,
  type ActiveClosure,
  type CaptureUnit,
  type ExecuteJobOptions,
  type RequestOutcome,
} from "./lifecycle.js";

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "can-bgi05-life-"));
}

function testRecipe(overrides: Partial<EffectiveRecipe> = {}): EffectiveRecipe {
  return {
    runner: "codex",
    model: "test-model",
    max_attempts: 1,
    timeout_seconds: 30,
    native: {},
    origins: {},
    settings: null,
    recipe_source: "test",
    ...overrides,
  };
}

function targets(): AllowedTarget[] {
  return [
    { handle: "h-style", role: "style", kind: "style", filename: "style.css" },
    { handle: "h-server", role: "server", kind: "view", filename: "server.js" },
  ];
}

async function writeTree(root: string, files: Array<[string, string]>): Promise<void> {
  for (const [rel, text] of files) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, text);
  }
}

async function writeFake(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}`);
  await chmod(path, 0o755);
  return path;
}

async function waitFor(cond: () => Promise<boolean>, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const noopPreflight = (): void => {};

const DUMP_FAKE = `
const fs = require("node:fs");
const path = require("node:path");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const out = { argv: args, cwd: process.cwd(), stdin };
  const binding = process.env.CAN_GENERATION_SESSION_FILE;
  out.hasBinding = typeof binding === "string" && binding.length > 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(binding, "utf8"));
    out.binding = { session: parsed.session, attempt: parsed.attempt, allowed: parsed.allowed };
  } catch (e) { out.bindingError = String((e && e.message) || e); }
  const cIdx = args.indexOf("-C");
  if (cIdx !== -1 && cIdx + 1 < args.length) {
    try {
      fs.writeFileSync(path.join(args[cIdx + 1], "agent-probe.txt"), "x");
      out.snapshotWrite = "wrote";
    } catch (e) { out.snapshotWrite = "refused:" + ((e && e.code) || "err"); }
  }
  fs.writeFileSync("agent-stray.txt", "stray");
  out.envLeak = Object.values(process.env).some((v) => typeof v === "string" && v.includes("candidates"));
  fs.writeFileSync("fake-dump.json", JSON.stringify(out));
  console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread-1" }));
});
`;

const SLOW_DUMP_FAKE = `
const fs = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  setTimeout(() => {
    fs.writeFileSync("fake-dump.json", JSON.stringify({ argv: process.argv.slice(2), stdin }));
    console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread-slow" }));
  }, 1200);
});
`;

const FAIL_FAKE = `
const fs = require("node:fs");
fs.appendFileSync("tries.log", "try\\n");
process.stderr.write("model exploded\\n");
process.exit(1);
`;

const FLAKY_FAKE = `
const fs = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  fs.appendFileSync("stdins.log", "---\\n" + stdin + "\\n");
  let n = 0;
  try { n = fs.readFileSync("tries.log", "utf8").split("\\n").filter(Boolean).length; } catch {}
  fs.appendFileSync("tries.log", "try\\n");
  if (n === 0) { process.stderr.write("first try fails\\n"); process.exit(1); }
  console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread-2" }));
});
`;

const SLEEP_FAKE = `
setTimeout(() => {}, 30000);
`;

interface FakeDump {
  argv: string[];
  cwd: string;
  stdin: string;
  hasBinding: boolean;
  binding?: { session: string; attempt: string; allowed: number };
  bindingError?: string;
  snapshotWrite?: string;
  envLeak?: boolean;
}

async function readDump(attemptDir: string): Promise<FakeDump> {
  return JSON.parse(await readFile(join(attemptDir, "fake-dump.json"), "utf8")) as FakeDump;
}

function unit(id: string, category: "given" | "frontend", agent: string | null = null): CaptureUnit {
  return { unit_id: id, kind: "style", category, prompt: `prompt for ${id}`, agent };
}

test("retry plans every closure prompt grouped by compatible recipe", () => {
  const closure: ActiveClosure = {
    app_id: "app-1",
    root: "/root",
    source_digest: "digest-1",
    units: [unit("g1", "given"), unit("g2", "given"), unit("f1", "frontend"), unit("f2", "frontend", "fast")],
  };
  const shared = testRecipe({ model: "m-shared" });
  const frontend = testRecipe({ model: "m-frontend" });
  const fast = testRecipe({ runner: "opencode", model: "m-fast" });
  const jobs = buildRetryJobs(closure, (candidate) =>
    candidate.agent === "fast" ? fast : candidate.category === "frontend" ? frontend : shared,
  );
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs[0]!.units.map((u) => u.unit_id), ["g1", "g2"]);
  assert.equal(jobs[0]!.order, 0);
  const frontJob = jobs.find((job) => job.units.some((u) => u.unit_id === "f1"))!;
  assert.deepEqual(frontJob.contextUnits.map((u) => u.unit_id).sort(), ["f1", "f2"]);
  const fastJob = jobs.find((job) => job.units.some((u) => u.unit_id === "f2"))!;
  assert.equal(fastJob.recipe.runner, "opencode");
  assert.deepEqual(fastJob.contextUnits.map((u) => u.unit_id).sort(), ["f1", "f2"]);
  const covered = jobs.flatMap((job) => job.units.map((u) => u.unit_id)).sort();
  assert.deepEqual(covered, ["f1", "f2", "g1", "g2"]);
  assert.ok(jobs[0]!.order < frontJob.order);
});

test("invalid closures refuse without planning", () => {
  const base: ActiveClosure = { app_id: "a", root: "r", source_digest: "d", units: [unit("u", "given")] };
  const shared = (): EffectiveRecipe => testRecipe();
  assert.throws(() => buildRetryJobs({ ...base, units: [] }, shared), LifecycleError);
  assert.throws(() => buildRetryJobs({ ...base, app_id: "" }, shared), LifecycleError);
  assert.throws(
    () => buildRetryJobs({ ...base, units: [{ ...unit("u", "given"), prompt: "" }] }, shared),
    LifecycleError,
  );
});

test("refine captures current edited files plus the instruction", () => {
  const baseline = buildRefineBaseline({
    unit_id: "u1",
    files: [{ path: "/root/style.css", content: ".edited{}" }],
    intent: "style intent",
    instruction: "make it calmer",
  });
  assert.equal(baseline.baseline, "current");
  assert.equal(baseline.files[0]!.content, ".edited{}");
  assert.equal(baseline.instruction, "make it calmer");
  assert.throws(
    () => buildRefineBaseline({ unit_id: "u1", files: [], intent: "i", instruction: "" }),
    LifecycleError,
  );
});

test("fresh uses source intent as baseline with current code only for protection", () => {
  const baseline = buildFreshBaseline({
    unit_id: "u1",
    intent: "style intent",
    protection_snapshot: [{ path: "/root/style.css", content: ".old{}" }],
  });
  assert.equal(baseline.baseline, "source-intent");
  assert.equal(baseline.intent, "style intent");
  assert.ok(!("files" in baseline));
  assert.ok(!JSON.stringify({ intent: baseline.intent }).includes(".old{}"));
  assert.equal(baseline.protection_snapshot[0]!.content, ".old{}");
});

test("input hashes are stable across key order", () => {
  assert.equal(hashInput({ a: 1, b: [2, { c: 3 }] }), hashInput({ b: [2, { c: 3 }], a: 1 }));
});

test("the ledger recovers matches, conflicts on change, and honors reset", async () => {
  const root = await freshRoot();
  const stateDir = join(root, "state");
  const outcome: RequestOutcome = {
    state: "candidate",
    exit: 0,
    attempt: "a",
    session: "s",
    fence: 0,
    detail: "done",
    next: [],
    submission_complete: true,
    qualified: false,
    tries: 1,
  };
  assert.deepEqual(await lookupRequest(stateDir, "r1", hashInput({ x: 1 })), { status: "absent" });
  await storeRequest(stateDir, "r1", hashInput({ x: 1 }), outcome);
  assert.deepEqual(await lookupRequest(stateDir, "r1", hashInput({ x: 1 })), {
    status: "same",
    outcome,
  });
  assert.deepEqual(await lookupRequest(stateDir, "r1", hashInput({ x: 2 })), { status: "conflict" });
  await markSuperseded(stateDir, "r1");
  assert.deepEqual(await lookupRequest(stateDir, "r1", hashInput({ x: 1 })), { status: "superseded" });
});

test("ledger request ids cannot escape the requests dir", async () => {
  const root = await freshRoot();
  const stateDir = join(root, "state");
  await storeRequest(
    stateDir,
    "../../evil",
    hashInput(1),
    {
      state: "failed",
      exit: 5,
      attempt: "a",
      session: "s",
      fence: 0,
      detail: "d",
      next: [],
      submission_complete: false,
      qualified: false,
      tries: 0,
    },
  );
  assert.deepEqual(await readdir(root), ["state"]);
  assert.deepEqual(await readdir(join(stateDir, "requests")), ["id-" + `${hashInput("../../evil")}` + ".json"]);
});

test("unreadable ledger records report unknown completion", async () => {
  const root = await freshRoot();
  const stateDir = join(root, "state");
  await mkdir(join(stateDir, "requests"), { recursive: true });
  await writeFile(join(stateDir, "requests", "r9.json"), "{broken");
  const error = await lookupRequest(stateDir, "r9", "x").catch((e: unknown) => e);
  assert.ok(error instanceof LifecycleError);
  assert.equal(error.exit, 6);
});

test("fences start at zero and advance with reasons", async () => {
  const root = await freshRoot();
  const attemptDir = join(root, "attempt");
  assert.equal(await readFence(attemptDir), 0);
  assert.equal(await advanceFence(attemptDir, "cancel"), 1);
  assert.equal(await readFence(attemptDir), 1);
  const fence = JSON.parse(await readFile(join(attemptDir, "fence.json"), "utf8")) as { reason: string };
  assert.equal(fence.reason, "cancel");
});

test("runner session ids extract best-effort from JSONL output", () => {
  assert.equal(extractRunnerSession('{"type":"thread.started","thread_id":"t1"}\n'), "t1");
  assert.equal(extractRunnerSession('{"session_id":"s2"}\n'), "s2");
  assert.equal(extractRunnerSession("plain text\n{broken\n"), null);
});

function baseOptions(root: string, overrides: Partial<ExecuteJobOptions> = {}): ExecuteJobOptions {
  return {
    request_id: "req-1",
    input: { op: "generate" },
    recipe: testRecipe(),
    source_digest: "digest-1",
    allowed: targets(),
    prompt: "Generate. $(must stay literal) `and this`",
    snapshotDir: join(root, "snapshot"),
    attemptDir: join(root, "attempt"),
    stateDir: join(root, "state"),
    preflight: noopPreflight,
    ...overrides,
  };
}

test("default preflight refuses real launch with no attempt artifacts", async () => {
  const root = await freshRoot();
  await writeTree(root, [["snapshot/app.can", "app"]]);
  let resolved = 0;
  const options = baseOptions(root, {
    resolveExecutable: async () => {
      resolved += 1;
      return "/nonexistent";
    },
  });
  const { preflight: _dropped, ...withoutPreflight } = options;
  void _dropped;
  await assert.rejects(executeJob(withoutPreflight), PreflightError);
  assert.equal(resolved, 0);
  await assert.rejects(readdir(join(root, "attempt")), /ENOENT/);
});

test("fake executable shows argv, attachment, read-only access, host placement", async () => {
  const root = await freshRoot();
  await writeTree(root, [["snapshot/app.can", "Given x"]]);
  const fake = await writeFake(root, "fake-dump", DUMP_FAKE);
  const phases: string[] = [];
  const outcome = await executeJob(
    baseOptions(root, {
      request_id: "req-happy",
      resolveExecutable: async () => fake,
      onEvent: (phase) => {
        phases.push(phase);
      },
    }),
  );
  assert.equal(outcome.state, "candidate");
  assert.equal(outcome.exit, 0);
  assert.equal(outcome.qualified, false);
  assert.equal(outcome.submission_complete, false);
  assert.deepEqual(phases, ["planned", "launched", "completed"]);
  const dump = await readDump(join(root, "attempt"));
  assert.deepEqual(dump.argv.slice(0, 6), ["exec", "--json", "--color", "never", "-s", "read-only"]);
  assert.ok(dump.argv.includes("-m"));
  assert.ok(dump.argv.includes("--output-schema"));
  assert.equal(dump.argv[dump.argv.length - 1], "-");
  assert.equal(dump.hasBinding, true);
  assert.equal(dump.binding?.allowed, 2);
  assert.equal(dump.bindingError, undefined);
  assert.equal(dump.stdin, "Generate. $(must stay literal) `and this`");
  assert.ok(dump.snapshotWrite?.startsWith("refused:"));
  assert.equal(dump.envLeak, false);
  // The snapshot is byte-identical and writable again after the run.
  assert.equal(await readFile(join(root, "snapshot", "app.can"), "utf8"), "Given x");
  await assert.rejects(readFile(join(root, "snapshot", "agent-probe.txt"), "utf8"));
  await writeFile(join(root, "snapshot", "writable-again.txt"), "ok");
  await rm(join(root, "snapshot", "writable-again.txt"));
  // The binding carries no physical paths.
  const binding = await readFile(join(root, "attempt", "session.json"), "utf8");
  assert.ok(!binding.includes(root));
  assert.ok(!binding.includes("candidates"));
  const record = await readAttempt(join(root, "attempt"));
  assert.equal(record.runner_session, "fake-thread-1");
});

test("stray agent files are never collected as candidates", async () => {
  const root = await freshRoot();
  await writeTree(root, [["snapshot/app.can", "app"]]);
  const fake = await writeFake(root, "fake-dump", DUMP_FAKE);
  const box: { session?: McpSession } = {};
  await executeJob(
    baseOptions(root, {
      request_id: "req-stray",
      resolveExecutable: async () => fake,
      onSession: (session) => {
        box.session = session;
      },
    }),
  );
  await box.session!.submit(box.session!.id, [
    { target: "h-style", role: "style", content_text: ".host{}" },
  ]);
  assert.equal(await readFile(join(root, "attempt", "agent-stray.txt"), "utf8"), "stray");
  assert.deepEqual(await readdir(join(root, "attempt", "candidates")), ["h-style"]);
  assert.deepEqual(await readdir(join(root, "attempt", "candidates", "h-style")), [
    "style.css",
    "submission.json",
  ]);
});

test("exit 0 with full submissions reports complete but never qualified", async () => {
  const root = await freshRoot();
  await writeTree(root, [["snapshot/app.can", "app"]]);
  const fake = await writeFake(root, "fake-slow", SLOW_DUMP_FAKE);
  const box: { session?: McpSession } = {};
  const pending = executeJob(
    baseOptions(root, {
      request_id: "req-submit",
      resolveExecutable: async () => fake,
      onSession: (session) => {
        box.session = session;
      },
    }),
  );
  await waitFor(async () => box.session !== undefined);
  await box.session!.submit(box.session!.id, [
    { target: "h-style", role: "style", content_text: ".a{}" },
    { target: "h-server", role: "server", content_text: "export {};" },
  ]);
  const outcome = await pending;
  assert.equal(outcome.state, "candidate");
  assert.equal(outcome.submission_complete, true);
  assert.equal(outcome.qualified, false);
});

test("matching resends recover without relaunch; changed input conflicts", async () => {
  const root = await freshRoot();
  await writeTree(root, [["snapshot/app.can", "app"]]);
  const fake = await writeFake(root, "fake-dump", DUMP_FAKE);
  let launches = 0;
  const first = await executeJob(
    baseOptions(root, {
      request_id: "req-idem",
      input: { op: "generate", n: 1 },
      resolveExecutable: async () => {
        launches += 1;
        return fake;
      },
    }),
  );
  assert.equal(launches, 1);
  const phases: string[] = [];
  const second = await executeJob(
    baseOptions(root, {
      request_id: "req-idem",
      input: { n: 1, op: "generate" },
      resolveExecutable: async () => {
        launches += 1;
        return fake;
      },
      onEvent: (phase) => {
        phases.push(phase);
      },
    }),
  );
  assert.equal(launches, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(phases, ["recovered"]);
  const error = await executeJob(
    baseOptions(root, {
      request_id: "req-idem",
      input: { op: "generate", n: 2 },
      resolveExecutable: async () => fake,
    }),
  ).catch((e: unknown) => e);
  assert.ok(error instanceof LifecycleError);
  assert.equal(error.exit, 3);
  assert.equal(error.code, "request-conflict");
});

test("known failures retry within finite bounds, then fail", async () => {
  const root = await freshRoot();
  await writeTree(root, [["snapshot/app.can", "app"]]);
  const fake = await writeFake(root, "fake-fail", FAIL_FAKE);
  const phases: string[] = [];
  const outcome = await executeJob(
    baseOptions(root, {
      request_id: "req-retry",
      recipe: testRecipe({ max_attempts: 2 }),
      resolveExecutable: async () => fake,
      onEvent: (phase) => {
        phases.push(phase);
      },
    }),
  );
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.exit, 5);
  assert.equal(outcome.tries, 2);
  assert.deepEqual(phases, ["planned", "launched", "retry", "completed"]);
  const tries = await readFile(join(root, "attempt", "tries.log"), "utf8");
  assert.equal(tries.split("\n").filter(Boolean).length, 2);
  assert.ok(outcome.detail.includes("model exploded"));
});

test("bounded retries name already-submitted and remaining handles", async () => {
  const root = await freshRoot();
  await writeTree(root, [["snapshot/app.can", "app"]]);
  const fake = await writeFake(root, "fake-flaky", FLAKY_FAKE);
  // One handle is already submitted before the run, so the bounded
  // retry notice deterministically names it plus the remainder.
  const prior = await createMcpSession({
    session: "prior",
    attempt: "prior",
    source_digest: "digest-1",
    allowed: targets(),
    candidateRoot: join(root, "attempt", "candidates"),
  });
  await prior.submit("prior", [{ target: "h-style", role: "style", content_text: ".a{}" }]);
  const outcome = await executeJob(
    baseOptions(root, {
      request_id: "req-notice",
      recipe: testRecipe({ max_attempts: 2 }),
      resolveExecutable: async () => fake,
    }),
  );
  assert.equal(outcome.state, "candidate");
  assert.equal(outcome.submission_complete, false);
  const stdins = await readFile(join(root, "attempt", "stdins.log"), "utf8");
  assert.ok(!stdins.split("---\n")[1]!.includes("[bounded retry"));
  const second = stdins.split("---\n")[2]!;
  assert.ok(second.includes("[bounded retry 2/2"));
  assert.ok(second.includes("already submitted: h-style"));
  assert.ok(second.includes("still required: h-server"));
});

test("missing executables fail fast without retry", async () => {
  const root = await freshRoot();
  await writeTree(root, [["snapshot/app.can", "app"]]);
  const outcome = await executeJob(
    baseOptions(root, {
      request_id: "req-missing",
      recipe: testRecipe({ max_attempts: 3 }),
      resolveExecutable: async () => join(root, "no-such-binary"),
    }),
  );
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.tries, 1);
  assert.ok(outcome.detail.includes("ENOENT") || outcome.detail.includes("spawn"));
});

test("timeouts report unknown completion and never auto-repeat", async () => {
  const root = await freshRoot();
  await writeTree(root, [["snapshot/app.can", "app"]]);
  const fake = await writeFake(root, "fake-sleep", SLEEP_FAKE);
  const outcome = await executeJob(
    baseOptions(root, {
      request_id: "req-timeout",
      recipe: testRecipe({ max_attempts: 3, timeout_seconds: 1 }),
      resolveExecutable: async () => fake,
    }),
  );
  assert.equal(outcome.state, "unknown");
  assert.equal(outcome.exit, 6);
  assert.equal(outcome.tries, 1);
  assert.ok(outcome.next.some((line) => line.includes("explicit new attempt")));
});

test("cancel fences the attempt and late submissions refuse", async () => {
  const root = await freshRoot();
  await writeTree(root, [["snapshot/app.can", "app"]]);
  const fake = await writeFake(root, "fake-sleep", SLEEP_FAKE);
  const registry = new Map<string, AbortController>();
  const box: { session?: McpSession } = {};
  const attemptDir = join(root, "attempt");
  const pending = executeJob(
    baseOptions(root, {
      request_id: "req-cancel",
      attemptDir,
      resolveExecutable: async () => fake,
      registry,
      registryKey: "k-cancel",
      onSession: (session) => {
        box.session = session;
      },
    }),
  );
  await waitFor(async () => {
    try {
      const record = await readAttempt(attemptDir);
      return record.pid !== null;
    } catch {
      return false;
    }
  });
  const live = box.session;
  assert.ok(live !== undefined);
  await cancelAttempt({ attemptDir, registry, registryKey: "k-cancel", session: live });
  const outcome = await pending;
  assert.equal(outcome.state, "cancelled");
  assert.equal(outcome.exit, 5);
  assert.ok(outcome.fence >= 1);
  assert.equal(live.state, "superseded");
  await assert.rejects(
    live.submit(live.id, [{ target: "h-style", role: "style", content_text: "x" }]),
    /session-superseded/,
  );
  assert.equal(await readFile(join(root, "snapshot", "app.can"), "utf8"), "app");
});

test("reset discards pending state and a resend starts fresh work", async () => {
  const root = await freshRoot();
  await writeTree(root, [["snapshot/app.can", "app"]]);
  const fake = await writeFake(root, "fake-dump", DUMP_FAKE);
  const box: { session?: McpSession } = {};
  const attemptDir = join(root, "attempt");
  const stateDir = join(root, "state");
  await executeJob(
    baseOptions(root, {
      request_id: "req-reset",
      attemptDir,
      stateDir,
      resolveExecutable: async () => fake,
      onSession: (session) => {
        box.session = session;
      },
    }),
  );
  const live = box.session;
  assert.ok(live !== undefined);
  await live.submit(live.id, [{ target: "h-style", role: "style", content_text: ".a{}" }]);
  const fence = await resetAttempt({ attemptDir, session: live, stateDir });
  assert.equal(fence, 1);
  await assert.rejects(readdir(join(attemptDir, "candidates")), /ENOENT/);
  await assert.rejects(readFile(join(attemptDir, "session.json"), "utf8"), /ENOENT/);
  assert.ok((await readAttempt(attemptDir)).attempt.length > 0);
  await assert.rejects(
    live.submit(live.id, [{ target: "h-server", role: "server", content_text: "x" }]),
    /session-superseded/,
  );
  let launches = 0;
  const outcome = await executeJob(
    baseOptions(root, {
      request_id: "req-reset",
      input: { op: "generate" },
      attemptDir,
      stateDir,
      resolveExecutable: async () => {
        launches += 1;
        return fake;
      },
    }),
  );
  assert.equal(launches, 1);
  assert.equal(outcome.state, "candidate");
  assert.equal(await readFile(join(root, "snapshot", "app.can"), "utf8"), "app");
});

test("resume continues a recorded session with an applicable capture", async () => {
  const root = await freshRoot();
  await writeTree(root, [["snapshot/app.can", "app"]]);
  const fake = await writeFake(root, "fake-dump", DUMP_FAKE);
  const recordedDir = join(root, "recorded");
  await executeJob(
    baseOptions(root, {
      request_id: "req-rec",
      attemptDir: recordedDir,
      resolveExecutable: async () => fake,
    }),
  );
  const resumedDir = join(root, "resumed");
  const outcome = await resumeSession({
    request_id: "req-resume",
    input: { op: "resume" },
    recordedAttemptDir: recordedDir,
    capture_digest: "digest-1",
    prompt: "Continue.",
    attemptDir: resumedDir,
    stateDir: join(root, "state"),
    allowed: targets(),
    preflight: noopPreflight,
    resolveExecutable: async () => fake,
  });
  assert.equal(outcome.state, "candidate");
  const dump = await readDump(resumedDir);
  assert.deepEqual(dump.argv.slice(0, 3), ["exec", "resume", "fake-thread-1"]);
  assert.equal(await readFence(recordedDir), 1);
  const record = await readAttempt(resumedDir);
  assert.ok(record.resumed_from !== null);
});

test("resume refuses fenced, changed, and unrecorded sessions", async () => {
  const root = await freshRoot();
  await writeTree(root, [["snapshot/app.can", "app"]]);
  const fake = await writeFake(root, "fake-dump", DUMP_FAKE);
  const recordedDir = join(root, "recorded");
  await executeJob(
    baseOptions(root, {
      request_id: "req-rec2",
      attemptDir: recordedDir,
      resolveExecutable: async () => fake,
    }),
  );
  const changed = await resumeSession({
    request_id: "req-changed",
    input: { op: "resume" },
    recordedAttemptDir: recordedDir,
    capture_digest: "digest-2",
    prompt: "Continue.",
    attemptDir: join(root, "resumed-changed"),
    stateDir: join(root, "state"),
    allowed: targets(),
    preflight: noopPreflight,
    resolveExecutable: async () => fake,
  }).catch((e: unknown) => e);
  assert.ok(changed instanceof LifecycleError);
  assert.equal(changed.code, "capture-changed");
  await resumeSession({
    request_id: "req-resume2",
    input: { op: "resume" },
    recordedAttemptDir: recordedDir,
    capture_digest: "digest-1",
    prompt: "Continue.",
    attemptDir: join(root, "resumed-ok"),
    stateDir: join(root, "state"),
    allowed: targets(),
    preflight: noopPreflight,
    resolveExecutable: async () => fake,
  });
  const again = await resumeSession({
    request_id: "req-resume3",
    input: { op: "resume" },
    recordedAttemptDir: recordedDir,
    capture_digest: "digest-1",
    prompt: "Continue.",
    attemptDir: join(root, "resumed-again"),
    stateDir: join(root, "state"),
    allowed: targets(),
    preflight: noopPreflight,
    resolveExecutable: async () => fake,
  }).catch((e: unknown) => e);
  assert.ok(again instanceof LifecycleError);
  assert.equal(again.code, "session-superseded");
  const bare = join(root, "bare");
  await mkdir(bare, { recursive: true });
  await writeFile(
    join(bare, "attempt.json"),
    JSON.stringify({
      attempt: "a",
      session: "s",
      request_id: "r",
      capture_digest: "digest-1",
      snapshotDir: join(root, "snapshot"),
      recipe: testRecipe(),
      fence: 0,
      runner_session: null,
      pid: null,
      resumed_from: null,
      state: "candidate",
    }),
  );
  const missing = await resumeSession({
    request_id: "req-resume4",
    input: { op: "resume" },
    recordedAttemptDir: bare,
    capture_digest: "digest-1",
    prompt: "Continue.",
    attemptDir: join(root, "resumed-bare"),
    stateDir: join(root, "state"),
    allowed: targets(),
    preflight: noopPreflight,
    resolveExecutable: async () => fake,
  }).catch((e: unknown) => e);
  assert.ok(missing instanceof LifecycleError);
  assert.equal(missing.code, "no-recorded-session");
});
