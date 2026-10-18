import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "node:net";
import { expect, it } from "vitest";
import { startLocalDev, type LocalDev, type LocalDevOptions } from "../src/runtime/native-preview.test-support.js";
import { ResourceCleanupError } from "../src/runtime/resource-lifetime.js";

function options(source = 'export default { fetch() { return new Response("ready"); } };'): LocalDevOptions {
  return { workerName: "lifecycle", compatibilityDate: "2026-07-15", mainModule: "main.js", modules: { "main.js": source } };
}

interface Process { pid: number; parent: number; command: string }
function processes(): Process[] {
  return execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3]! }] : [];
  });
}
function workerdPids(owner = process.pid, retained = new Set<number>()): number[] {
  const rows = processes(), descendants = new Set([owner]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (descendants.has(row.parent) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; }
  }
  for (const row of rows) if (descendants.has(row.pid) && /(?:^|\/)workerd$/.test(row.command)) retained.add(row.pid);
  return rows.filter(row => retained.has(row.pid) && /(?:^|\/)workerd$/.test(row.command)).map(row => row.pid).sort((a, b) => a - b);
}
function listeners(): number {
  return (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles()
    .filter(handle => handle instanceof Server && handle.listening).length;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function released(pids: number[], count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (JSON.stringify(workerdPids()) !== JSON.stringify(pids) || listeners() !== count) {
    if (Date.now() >= deadline) throw new Error(`owned resources did not return to baseline: workerd=${workerdPids()}, listeners=${listeners()}`);
    await delay(25);
  }
}

it("bounds native-owner workerd across unchanged checks, rebuilds, stale candidates, cancellation and stop", async () => {
  const repo = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const directory = await realpath(await mkdtemp(join(tmpdir(), "can-native-lifecycle-")));
  const root = join(directory, "project"), source = join(root, "Preview.can");
  await mkdir(root, { mode: 0o700 });
  const template = await readFile(join(repo, "tests/integration/can-dev-server/ModelFreePreview.can"), "utf8");
  await writeFile(source, template);
  const binary = process.env.CAN_DEV_BIN ?? join(repo, "compiler/target/debug/can-dev");
  const env = { ...process.env, CAN_DEV_RUNTIME_HOST: process.env.CAN_DEV_RUNTIME_HOST ?? join(repo, "dev-server/host/entry.mjs"), CAN_DEV_STATE_ROOT: join(directory, "state") };
  let session: string | undefined, owner = 0, peak = 0, stopped = false;
  const retained = new Set<number>(), timings: number[] = [];
  type Reply = { ok: boolean; session?: string; code?: string; result: any };
  function launch(command: string, flags: string[] = []): { child: ChildProcess; done: Promise<{ code: number | null; signal: NodeJS.Signals | null; reply?: Reply }> } {
    const child = spawn(binary, [command, "--root", root, ...(session ? ["--session", session] : []), ...flags], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout!.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr!.resume();
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; reply?: Reply }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => { try { resolve({ code, signal, ...(stdout.trim() ? { reply: JSON.parse(stdout) as Reply } : {}) }); } catch (error) { reject(error); } });
    });
    return { child, done };
  }
  async function control(command: string, flags: string[] = []) {
    const value = await launch(command, flags).done;
    expect(value.code, JSON.stringify(value.reply)).toBe(0);
    expect(value.reply?.ok, JSON.stringify(value.reply)).toBe(true);
    return value.reply!;
  }
  const sample = () => { const pids = workerdPids(owner, retained); peak = Math.max(peak, pids.length); return pids; };
  async function idle() {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const status = (await control("status")).result;
      if (status.observation.admission.check && !status.observation.admission.reasons.includes("cleanup_required")) return status;
      if (Date.now() >= deadline) throw new Error(`native owner did not release candidate: ${JSON.stringify(status)}`);
      await delay(25);
    }
  }
  async function checked() {
    const started = performance.now();
    const result = (await control("check")).result;
    timings.push(Math.round(performance.now() - started));
    expect(result.state).toBe("valid"); expect(result.preview).toBe("ready");
    await idle(); expect(sample()).toHaveLength(1);
    const opened = (await control("preview.open")).result.url;
    const bootstrap = await fetch(opened, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    expect(bootstrap.status).toBe(303);
    const cookie = bootstrap.headers.getSetCookie().map(line => line.split(";", 1)[0]!).join("; ");
    const descriptor = await fetch(new URL("/auth/login", opened), { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    expect(descriptor.status).toBe(200);
    expect((await descriptor.json() as { preSessionToken: string }).preSessionToken).toBeTypeOf("string");
    return result;
  }
  async function candidate(pending: ReturnType<typeof launch>) {
    let settled = false;
    void pending.done.then(() => { settled = true; });
    const deadline = Date.now() + 60_000;
    for (;;) {
      const status = (await control("status")).result;
      if (status.observation.operation?.phase === "preparing_preview" && sample().length === 2) return;
      if (settled) throw new Error(`candidate completed before overlap: ${JSON.stringify(status)}`);
      if (Date.now() >= deadline) throw new Error(`native preview candidate did not allocate: ${JSON.stringify(status)}`);
      await delay(10);
    }
  }
  const foreign = await startLocalDev(options());
  const foreignPids = workerdPids();
  let sampler: ReturnType<typeof setInterval> | undefined;
  try {
    const started = await control("start", ["--source", source, "--compiler", process.env.CAN_COMPILER_BIN ?? join(repo, "compiler/target/debug/can"), "--catalog", join(repo, "packages/values/dist/catalog.json"), "--help-index", join(repo, "docs/specification/CONSTRUCT-HELP.md")]);
    session = started.session; expect(session).toBeTypeOf("string");
    const descriptor = JSON.parse(await readFile(join(await realpath(tmpdir()), `cv-${process.getuid!()}`, createHash("sha256").update(root).digest("hex").slice(0, 24), "descriptor.json"), "utf8"));
    expect(descriptor.sessionId).toBe(session); expect(descriptor.root).toBe(root); owner = descriptor.pid;
    sampler = setInterval(sample, 20);
    await checked();
    const original = sample(), firstBuild = (await control("status")).result.serving_build;
    for (let i = 0; i < 3; i++) { await checked(); expect(sample()).toEqual(original); }
    expect((await control("status")).result.serving_build).toBe(firstBuild);
    for (let i = 0; i < 3; i++) {
      await writeFile(source, `${template}\n## Native lifecycle rebuild ${i}.\n`);
      await checked(); expect(sample()).not.toEqual(original);
    }
    const lastGood = (await control("status")).result.serving_build;
    await writeFile(source, `${template}\n## Candidate to supersede.\n`);
    const stale = launch("check"); await candidate(stale);
    await writeFile(source, `${template}\n## Changed during candidate preparation.\n`);
    const superseded = await stale.done;
    expect(superseded.reply?.ok).toBe(true); expect(superseded.reply?.result.state).toBe("superseded");
    expect((await idle()).serving_build).toBe(lastGood); expect(sample()).toHaveLength(1);
    await writeFile(source, `${template}\n## Candidate canceled by disconnected check caller.\n`);
    const canceled = launch("check"); await candidate(canceled); canceled.child.kill("SIGTERM");
    expect((await canceled.done).signal).toBe("SIGTERM");
    expect((await idle()).serving_build).toBe(lastGood); expect(sample()).toHaveLength(1);
    expect(peak).toBe(2);
    await control("stop"); stopped = true;
    const deadline = Date.now() + 5_000;
    while (sample().length && Date.now() < deadline) await delay(25);
    expect(sample()).toEqual([]);
    expect(workerdPids()).toEqual(foreignPids);
    expect(await (await foreign.dispatch("/")).text()).toBe("ready");
    console.log(JSON.stringify({ nativeCheckMs: timings, peakOwnedWorkerd: peak, remainingOwnedWorkerd: sample().length, independentCallerUntouched: true }));
  } finally {
    if (sampler) clearInterval(sampler);
    try { if (session && !stopped) await control("stop"); }
    finally { await foreign.dispose(); await rm(directory, { recursive: true, force: true }); }
  }
}, 240_000);

it("releases failed startup resources and preserves independent callers", async () => {
  const baseline = workerdPids(), baselineListeners = listeners();
  for (const source of ['throw new Error("startup refused"); export default {};', 'import "./missing.js"; export default {};']) {
    const failure = await startLocalDev(options(source)).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ResourceCleanupError);
    await released(baseline, baselineListeners);
  }
  let first: LocalDev | undefined, second: LocalDev | undefined;
  try {
    first = await startLocalDev(options()); second = await startLocalDev(options());
    expect(workerdPids()).toHaveLength(baseline.length + 2);
    await Promise.all([first.dispose(), first.dispose()]);
    expect(workerdPids()).toHaveLength(baseline.length + 1);
    expect(await (await second.dispatch("/")).text()).toBe("ready");
  } finally { await first?.dispose(); await second?.dispose(); }
  await released(baseline, baselineListeners);
}, 30_000);

it("stops workerd without waiting for an unfinished recovery dispatch", async () => {
  const baseline = workerdPids(), baselineListeners = listeners();
  const dev = await startLocalDev({ ...options(`let entered = false; export default {
    fetch() { return Response.json({ entered }); },
    async scheduled() { entered = true; await new Promise(resolve => setTimeout(resolve, 60_000)); }
  };`), resourceRecovery: true });
  try {
    const deadline = Date.now() + 5_000;
    while (!(await (await dev.dispatch("/")).json() as { entered: boolean }).entered) {
      if (Date.now() >= deadline) throw new Error("recovery did not enter");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally { await dev.dispose(); }
  await released(baseline, baselineListeners);
}, 10_000);
