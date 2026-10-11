import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevRevisionConflictError, DevSessionCore, type DevPreview } from "../src/dev/session-core.js";

function preview(id: string, disposed: string[]): DevPreview {
  return { id, dispose: async () => { disposed.push(id); } };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("session did not reconcile changed inputs");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe("development session revision lifecycle", () => {
  it("refuses request capture canceled behind an ongoing manual capture without changing its identity", async () => {
    let captures = 0, checks = 0, previews = 0, entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const session = new DevSessionCore({
      capture: async () => {
        captures++; entered(); await gate;
        return { sourceRevision: captures === 1 ? "original" : "unexpected", inputDigest: captures === 1 ? "original" : "unexpected" };
      },
      check: async () => { checks++; return { complete: true, passed: true, detail: null }; },
      preparePreview: async () => { previews++; return preview("unexpected", []); },
    });
    try {
      const manual = session.refresh(); await started;
      const controller = new AbortController(), reason = new Error("capture caller disconnected");
      const check = session.check(undefined, controller.signal), rejection = expect(check).rejects.toBe(reason);
      // checkOne has synchronously enqueued its refresh before yielding to this
      // continuation; the original manual capture still owns the queue.
      await Promise.resolve(); controller.abort(reason); release();
      expect(await manual).toEqual({ sourceRevision: "original", inputDigest: "original" });
      await rejection;
      expect(captures).toBe(1); expect(checks).toBe(0); expect(previews).toBe(0);
      expect(session.status()).toMatchObject({ revision: "r1", sourceRevision: "original", captureError: null, servingBuild: null });
    } finally { release(); await session.stop(); }
  });

  it("refuses a canceled queued check before capture or compiler work", async () => {
    let captures = 0, checks = 0;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const session = new DevSessionCore({
      capture: async () => { captures++; return { sourceRevision: "a", inputDigest: "a" }; },
      check: async () => { checks++; entered(); await gate; return { complete: true, passed: false, detail: null }; },
      preparePreview: async () => { throw new Error("invalid check cannot build"); },
    });
    try {
      const first = session.check(); await started;
      const controller = new AbortController(), reason = new Error("queued caller disconnected");
      const queued = session.check(undefined, controller.signal);
      const rejection = expect(queued).rejects.toBe(reason);
      controller.abort(reason); release(); await first;
      const capturedByFirst = captures;
      await rejection; expect(captures).toBe(capturedByFirst); expect(checks).toBe(1);
    } finally { release(); await session.stop(); }
  });

  it("aborts an in-flight compiler with the request and keeps the check queue usable", async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let first = true, compilerSignal: AbortSignal | undefined;
    const session = new DevSessionCore({
      capture: async () => ({ sourceRevision: "a", inputDigest: "a" }),
      check: async (_inputs, signal) => {
        if (first) { first = false; compilerSignal = signal; entered();
          await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
        return { complete: true, passed: false, detail: null };
      },
      preparePreview: async () => { throw new Error("invalid check cannot build"); },
    });
    try {
      const controller = new AbortController(), reason = new Error("compiler caller timed out");
      const check = session.check(undefined, controller.signal), rejection = expect(check).rejects.toBe(reason);
      await started; controller.abort(reason); await rejection;
      expect(compilerSignal?.aborted).toBe(true);
      expect(session.detail("r1")).toEqual({ error: "revision_unavailable" });
      expect(await session.check()).toMatchObject({ kind: "checked", preview: "unavailable" });
    } finally { await session.stop(); }
  });

  it("awaits canceled prepared preview disposal without replacing the old serving build", async () => {
    let source = "old", prepared!: () => void, release!: () => void, disposing!: () => void, finishDisposal!: () => void;
    const preparation = new Promise<void>(resolve => { prepared = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const disposal = new Promise<void>(resolve => { disposing = resolve; });
    const disposeGate = new Promise<void>(resolve => { finishDisposal = resolve; });
    const disposed: string[] = [];
    const session = new DevSessionCore({
      capture: async () => ({ sourceRevision: source, inputDigest: source }),
      check: async () => ({ complete: true, passed: true, detail: null }),
      preparePreview: async inputs => {
        if (inputs.sourceRevision === "old") return preview("old", disposed);
        prepared(); await gate;
        return { id: "new", dispose: async () => { disposing(); await disposeGate; disposed.push("new"); } };
      },
    });
    try {
      await session.check(); source = "new";
      const controller = new AbortController(), reason = new Error("preview caller disconnected");
      let settled = false;
      const check = session.check(undefined, controller.signal);
      const rejection = expect(check).rejects.toBe(reason);
      void check.then(() => { settled = true; }, () => { settled = true; });
      await preparation; controller.abort(reason); release(); await disposal;
      expect(settled).toBe(false); expect(session.status().servingBuild).toBe("old");
      expect(disposed).toEqual([]); finishDisposal(); await rejection;
      expect(disposed).toEqual(["new"]); expect(session.status().servingBuild).toBe("old");
    } finally { release(); finishDisposal(); await session.stop(); }
  });

  it("admits expected revisions against recaptured inputs before publishing", async () => {
    let source = "first";
    const session = new DevSessionCore({
      capture: async () => ({ sourceRevision: source, inputDigest: source }),
      check: async () => ({ complete: true, passed: true, detail: null }),
      preparePreview: async inputs => preview(inputs.sourceRevision, []),
    });
    try {
      expect(await session.check()).toMatchObject({ kind: "checked", revision: "r1" });
      source = "second";
      await expect(session.check("r1")).rejects.toBeInstanceOf(DevRevisionConflictError);
      expect(session.status()).toMatchObject({ revision: "r2", servingRevision: "r1", dirty: true });
      expect(session.detail("r2")).toEqual({ error: "revision_unavailable" });
    } finally {
      await session.stop();
    }
  });

  it("keeps a newly promoted preview available when old preview cleanup fails", async () => {
    let source = "first";
    const session = new DevSessionCore({
      capture: async () => ({ sourceRevision: source, inputDigest: source }),
      check: async () => ({ complete: true, passed: true, detail: null }),
      preparePreview: async inputs => ({
        id: inputs.sourceRevision,
        dispose: async () => { if (inputs.sourceRevision === "first") throw new Error("old worker disposal failed"); },
      }),
    });
    try {
      await session.check();
      source = "second";
      const result = await session.check();
      expect(result).toMatchObject({ kind: "checked", revision: "r2", preview: "ready", cleanupError: "old worker disposal failed" });
      expect(session.status()).toMatchObject({ servingRevision: "r2", servingBuild: "second" });
    } finally {
      await session.stop();
    }
  });

  it("retains an old serving build across an invalid edit and resets data on repair", async () => {
    let source = "a";
    const disposed: string[] = [];
    const session = new DevSessionCore(
      {
        capture: async () => ({ sourceRevision: source, inputDigest: source }),
        check: async (inputs) => ({ complete: true, passed: inputs.sourceRevision !== "bad", detail: { source: inputs.sourceRevision } }),
        preparePreview: async (inputs) => preview(`build-${inputs.sourceRevision}`, disposed),
      },
      { debounceMs: 100_000, historyLimit: 2 },
    );
    try {
      expect(await session.check()).toMatchObject({ kind: "checked", revision: "r1", preview: "ready" });
      expect(session.status()).toMatchObject({ servingRevision: "r1", stale: false });
      expect(await session.check()).toMatchObject({ kind: "checked", revision: "r1", preview: "ready" });
      expect(session.status()).toMatchObject({ servingRevision: "r1", previewReset: false });
      expect(disposed).toEqual([]);

      source = "bad";
      session.markDirty();
      expect(await session.check()).toMatchObject({ kind: "checked", revision: "r2", preview: "unavailable" });
      expect(session.status()).toMatchObject({ revision: "r2", servingRevision: "r1", stale: true });
      expect(session.detail("r1")).toMatchObject({ check: { detail: { source: "a" } } });

      source = "fixed";
      session.markDirty();
      expect(await session.check()).toMatchObject({ kind: "checked", revision: "r3", preview: "ready" });
      expect(session.status()).toMatchObject({ servingRevision: "r3", stale: false, previewReset: true });
      expect(disposed).toEqual(["build-a"]);
      expect(session.detail("r1")).toEqual({ error: "revision_unavailable" });
    } finally {
      await session.stop();
    }
    expect(disposed).toEqual(["build-a", "build-fixed"]);
  });

  it("cannot publish an in-flight result after the input changes", async () => {
    let source = "first";
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const disposed: string[] = [];
    const session = new DevSessionCore({
      capture: async () => ({ sourceRevision: source, inputDigest: source }),
      check: async (inputs) => {
        if (inputs.sourceRevision === "first") {
          entered?.();
          await gate;
        }
        return { complete: true, passed: true, detail: { source: inputs.sourceRevision } };
      },
      preparePreview: async (inputs) => preview(`build-${inputs.sourceRevision}`, disposed),
    }, { debounceMs: 100_000 });
    try {
      const pending = session.check();
      await started;
      source = "second";
      session.markDirty();
      release?.();
      expect(await pending).toMatchObject({ kind: "superseded", revision: "r1", sourceRevision: "first" });
      expect(session.status().servingBuild).toBeNull();
      expect(await session.check()).toMatchObject({ kind: "checked", revision: "r2", preview: "ready" });
      expect(session.detail("r1")).toEqual({ error: "revision_unavailable" });
    } finally {
      await session.stop();
    }
    expect(disposed).toEqual(["build-second"]);
  });

  it("reconciles source membership and bytes after missed add, rename, and remove events", async () => {
    const root = await mkdtemp(join(tmpdir(), "can-session-sources-"));
    const sources = join(root, "sources");
    await mkdir(sources);
    await writeFile(join(sources, "App.can"), "first");
    const session = new DevSessionCore({
      capture: async () => {
        const names = (await readdir(sources)).filter(name => name.endsWith(".can")).sort();
        const contents = await Promise.all(names.map(name => readFile(join(sources, name), "utf8")));
        const sourceRevision = JSON.stringify(names.map((name, index) => [name, contents[index]]));
        return { sourceRevision, inputDigest: sourceRevision };
      },
      check: async inputs => ({ complete: true, passed: true, detail: inputs.sourceRevision }),
      preparePreview: async inputs => preview(inputs.sourceRevision, []),
    }, { debounceMs: 5, reconcileMs: 20, auditMs: 60 });
    try {
      session.watchDirectories([sources]);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await session.check()).toMatchObject({ revision: "r1", preview: "ready" });
      await writeFile(join(sources, "Extra.can"), "added");
      await until(() => session.status().sourceRevision?.includes("Extra.can") === true);
      expect(session.status()).toMatchObject({ stale: true, dirty: true, servingRevision: "r1" });
      await session.check();
      const addedRevision = session.status().revision!;
      await rename(join(sources, "Extra.can"), join(sources, "Renamed.can"));
      await until(() => session.status().sourceRevision?.includes("Renamed.can") === true);
      await session.check();
      await rm(join(sources, "Renamed.can"));
      await until(() => session.status().sourceRevision?.includes("Renamed.can") === false);
      expect(session.detail(addedRevision)).toMatchObject({ check: { detail: expect.stringContaining("Extra.can") } });
    } finally {
      await session.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reattaches after a watched directory is replaced and polls non-source inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "can-session-watch-"));
    const watched = join(root, "watched");
    const old = join(root, "old");
    const installed = join(root, "installed.js");
    await mkdir(watched);
    await writeFile(join(watched, "App.can"), "first");
    await writeFile(installed, "one");
    const session = new DevSessionCore({
      capture: async () => {
        const sourceRevision = await readFile(join(watched, "App.can"), "utf8");
        return { sourceRevision, inputDigest: `${sourceRevision}:${await readFile(installed, "utf8")}` };
      },
      check: async inputs => ({ complete: true, passed: true, detail: inputs.inputDigest }),
      preparePreview: async inputs => preview(inputs.inputDigest, []),
    }, { debounceMs: 5, reconcileMs: 20, auditMs: 60 });
    try {
      session.watchDirectories([watched]);
      await new Promise(resolve => setTimeout(resolve, 100));
      await session.check();
      await writeFile(installed, "two");
      await until(() => session.status().revision === "r2");
      expect(session.status()).toMatchObject({ sourceRevision: "first", stale: true });
      await session.check();
      await rename(watched, old);
      await mkdir(watched);
      await writeFile(join(watched, "App.can"), "replacement");
      await until(() => session.status().sourceRevision === "replacement");
      await session.check();
      const servingRevision = session.status().servingRevision;
      await writeFile(join(watched, "App.can"), "later");
      await until(() => session.status().sourceRevision === "later");
      expect(session.status()).toMatchObject({ sourceRevision: "later", servingRevision, stale: true });
    } finally {
      await session.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers post-replacement edits through the reattached native watcher before any fallback audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "can-session-native-watch-"));
    const watched = join(root, "watched"), old = join(root, "old");
    const app = join(watched, "App.can");
    await mkdir(watched);
    await writeFile(app, "first");
    const auditMs = 60_000, started = Date.now();
    let captures = 0;
    const session = new DevSessionCore({
      capture: async () => {
        captures++;
        const sourceRevision = await readFile(app, "utf8");
        return { sourceRevision, inputDigest: sourceRevision };
      },
      check: async inputs => ({ complete: true, passed: true, detail: inputs.inputDigest }),
      preparePreview: async inputs => preview(inputs.inputDigest, []),
    }, { debounceMs: 5, reconcileMs: 20, auditMs });
    try {
      // Capture before starting polling: lastCaptureAt must not begin overdue.
      expect(await session.check()).toMatchObject({ revision: "r1", preview: "ready" });
      session.watchDirectories([watched]);
      await rename(watched, old);
      await mkdir(watched);
      await writeFile(app, "replacement");
      await until(() => session.status().sourceRevision === "replacement");
      // Let directory-identity reconciliation and its capture finish before
      // the next edit. Stable idle polls must not capture file contents.
      await new Promise(resolve => setTimeout(resolve, 100));
      const replacementCaptures = captures;
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(captures).toBe(replacementCaptures);
      expect(session.status().sourceRevision).toBe("replacement");
      // No check, refresh or markDirty follows this edit. The replacement
      // inode stays the same, so identity polling cannot discover its bytes.
      await writeFile(app, "native-later");
      await until(() => session.status().sourceRevision === "native-later");
      expect(captures).toBeGreaterThan(replacementCaptures);
      expect(session.status()).toMatchObject({ sourceRevision: "native-later", servingRevision: "r1", stale: true });
      expect(Date.now() - started).toBeLessThan(auditMs);
    } finally {
      await session.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 6_000);

  it("avoids full captures on idle identity polls but eventually audits a missed event", async () => {
    const root = await mkdtemp(join(tmpdir(), "can-session-idle-"));
    let source = "first";
    let captures = 0;
    const disposed: string[] = [];
    const session = new DevSessionCore({
      capture: async () => { captures++; return { sourceRevision: source, inputDigest: source }; },
      check: async () => ({ complete: true, passed: true, detail: null }),
      preparePreview: async inputs => preview(inputs.sourceRevision, disposed),
    }, { debounceMs: 5, reconcileMs: 10, auditMs: 200 });
    try {
      session.watchDirectories([root]);
      await new Promise(resolve => setTimeout(resolve, 100));
      await session.check();
      const checkedCaptures = captures;
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(captures).toBe(checkedCaptures);
      expect(session.status()).toMatchObject({ dirty: false, stale: false });
      // No filesystem event accompanies this producer change.
      source = "second";
      await until(() => session.status().sourceRevision === "second");
      expect(session.status()).toMatchObject({ revision: "r2", dirty: true, stale: true, servingRevision: "r1" });
      expect(captures).toBe(checkedCaptures + 1);
    } finally {
      await session.stop();
      await rm(root, { recursive: true, force: true });
    }
    const stoppedCaptures = captures;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(captures).toBe(stoppedCaptures);
    expect(disposed).toEqual(["first"]);
  });
});
