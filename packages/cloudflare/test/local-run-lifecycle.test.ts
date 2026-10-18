import { execFileSync } from "node:child_process";
import { Server } from "node:net";
import { expect, it } from "vitest";
import { startLocalDev, type LocalDev, type LocalDevOptions } from "../src/dev/local-run.js";
import { startProtectedPreview } from "../src/dev/preview-bridge.js";
import { DevSessionCore } from "../src/dev/session-core.js";
import { DevCleanupError } from "../src/dev/cleanup.js";

function options(source = 'export default { fetch() { return new Response("ready"); } };'): LocalDevOptions {
  return { workerName: "lifecycle", compatibilityDate: "2026-07-15", mainModule: "main.js", modules: { "main.js": source } };
}

function workerdPids(): number[] {
  return execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match && Number(match[2]) === process.pid && /(?:^|\/)workerd$/.test(match[3]!) ? [Number(match[1])] : [];
  }).sort((a, b) => a - b);
}

function listeners(): number {
  return (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles()
    .filter(handle => handle instanceof Server && handle.listening).length;
}

async function released(pids: number[], count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (JSON.stringify(workerdPids()) !== JSON.stringify(pids) || listeners() !== count) {
    if (Date.now() >= deadline) throw new Error(`owned resources did not return to baseline: workerd=${workerdPids()}, listeners=${listeners()}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

it("bounds real workerd instances across unchanged checks, rebuilds, stale builds, cancellation and stop", async () => {
  const baseline = workerdPids(), baselineListeners = listeners();
  let source = "first", builds = 0, peak = 0, mode: "normal" | "stale" | "cancel" = "normal";
  let controller: AbortController | undefined;
  const timings: number[] = [];
  const session = new DevSessionCore({
    capture: async () => ({ sourceRevision: source, inputDigest: source }),
    check: async () => ({ complete: true, passed: true, detail: null }),
    preparePreview: async inputs => {
      const started = performance.now();
      const dev = await startLocalDev(options());
      expect(await (await dev.dispatch("/")).text()).toBe("ready");
      timings.push(performance.now() - started);
      builds++;
      peak = Math.max(peak, workerdPids().length - baseline.length);
      const bridge = await startProtectedPreview(dev);
      if (mode === "stale") source = "changed-during-start";
      if (mode === "cancel") controller!.abort(new Error("caller left"));
      return { id: inputs.sourceRevision, dispose: async () => { await bridge.close(); await dev.dispose(); } };
    },
  });
  try {
    await session.check();
    const original = workerdPids();
    expect(original).toHaveLength(baseline.length + 1);
    for (let i = 0; i < 3; i++) await session.check();
    expect(builds).toBe(1); expect(workerdPids()).toEqual(original);
    for (let i = 0; i < 3; i++) {
      source = `rebuild-${i}`; await session.check();
      expect(workerdPids()).toHaveLength(baseline.length + 1);
    }
    mode = "stale"; source = "stale";
    expect(await session.check()).toMatchObject({ kind: "superseded" });
    expect(session.status().servingBuild).toBe("rebuild-2");
    expect(workerdPids()).toHaveLength(baseline.length + 1);
    mode = "cancel"; source = "canceled"; controller = new AbortController();
    await expect(session.check(undefined, controller.signal)).rejects.toThrow("caller left");
    expect(workerdPids()).toHaveLength(baseline.length + 1);
    expect(peak).toBe(2);
  } finally { await session.stop(); }
  await released(baseline, baselineListeners);
  console.log(JSON.stringify({ minimalRuntimeReadyAndFirstRequestMs: timings.map(value => Math.round(value)), peakOwnedWorkerd: peak,
    remainingOwnedWorkerd: workerdPids().length - baseline.length, remainingListeners: listeners() - baselineListeners }));
}, 30_000);

it("releases failed startup resources and preserves independent callers", async () => {
  const baseline = workerdPids(), baselineListeners = listeners();
  for (const source of ['throw new Error("startup refused"); export default {};', 'import "./missing.js"; export default {};']) {
    const failure = await startLocalDev(options(source)).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(DevCleanupError);
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
