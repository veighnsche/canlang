import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevRevisionConflictError, DevSessionCore, type DevPreview } from "../src/dev/session-core.js";
import { DevCleanupError } from "../src/dev/cleanup.js";

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
    let failCleanup = true, builds = 0;
    const session = new DevSessionCore({
      capture: async () => ({ sourceRevision: source, inputDigest: source }),
      check: async () => ({ complete: true, passed: true, detail: null }),
      preparePreview: async inputs => { builds++; return ({
        id: inputs.sourceRevision,
        dispose: async () => { if (inputs.sourceRevision === "first" && failCleanup) throw new Error("old worker disposal failed"); },
      }); },
    });
    try {
      await session.check();
      source = "second";
      const result = await session.check();
      expect(result).toMatchObject({ kind: "checked", revision: "r2", preview: "ready", cleanupError: "old worker disposal failed" });
      expect(session.status()).toMatchObject({ servingRevision: "r2", servingBuild: "second" });
      source = "third";
      await expect(session.check()).rejects.toThrow("old worker disposal failed");
      expect(builds).toBe(2);
      failCleanup = false;
      expect(await session.check()).toMatchObject({ kind: "checked", preview: "ready" });
      expect(builds).toBe(3);
    } finally {
      failCleanup = false;
      await session.stop();
    }
  });

  it("retains failed canceled-preview and partial-start cleanup for stop retry", async () => {
    for (const startupFailure of [false, true]) {
      let failCleanup = true, disposals = 0;
      const controller = new AbortController();
      const dispose = async () => { disposals++; if (failCleanup) throw new Error("runtime still alive"); };
      const session = new DevSessionCore({
        capture: async () => ({ sourceRevision: "a", inputDigest: "a" }),
        check: async () => ({ complete: true, passed: true, detail: null }),
        preparePreview: async () => {
          if (startupFailure) throw new DevCleanupError(new Error("startup failed"), new Error("runtime still alive"), dispose);
          controller.abort(new Error("caller disconnected"));
          return { id: "canceled", dispose };
        },
      });
      if (startupFailure) expect(await session.check()).toMatchObject({ kind: "build_failed" });
      else await expect(session.check(undefined, controller.signal)).rejects.toThrow("runtime still alive");
      await expect(session.stop()).rejects.toThrow("runtime still alive");
      failCleanup = false;
      await session.stop();
      expect(disposals).toBe(startupFailure ? 2 : 3);
      expect(session.status().servingBuild).toBeNull();
    }
  });

  it("concurrent stop callers await serving runtime release and can retry failure", async () => {
    let release!: () => void, entered!: () => void, attempts = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const disposing = new Promise<void>(resolve => { entered = resolve; });
    const session = new DevSessionCore({
      capture: async () => ({ sourceRevision: "a", inputDigest: "a" }),
      check: async () => ({ complete: true, passed: true, detail: null }),
      preparePreview: async () => ({ id: "serving", dispose: async () => {
        attempts++; entered(); await gate;
        if (attempts === 1) throw new Error("try cleanup again");
      } }),
    });
    await session.check();
    const first = session.stop(), second = session.stop();
    expect(second).toBe(first);
    const failures = Promise.allSettled([first, second]);
    await disposing; expect(attempts).toBe(1); release();
    expect((await failures).map(result => result.status)).toEqual(["rejected", "rejected"]);
    await session.stop(); expect(attempts).toBe(2);
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

  it.each(["check", "preview"] as const)("reconciles unchanged native directory hints during %s", async phase => {
    const root = await mkdtemp(join(tmpdir(), "can-session-sibling-")), app = join(root, "App.can");
    await writeFile(app, "unchanged");
    let entered!: () => void, release!: () => void, captures = 0;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const session = new DevSessionCore({
      capture: async () => { captures++; const source = await readFile(app, "utf8"); return { sourceRevision: source, inputDigest: source }; },
      check: async () => { if (phase === "check") { entered(); await gate; } return { complete: true, passed: true, detail: null }; },
      preparePreview: async () => { if (phase === "preview") { entered(); await gate; } return preview("unchanged", []); },
    }, { debounceMs: 5, reconcileMs: 20, auditMs: 60_000 });
    try {
      session.watchDirectories([root]);
      const pending = session.check(); await started;
      const before = captures;
      // The real watcher sees both an irrelevant sibling and a same-byte write.
      await writeFile(phase === "check" ? join(root, "Notes.md") : app, phase === "check" ? "not consumed" : "unchanged");
      await until(() => captures > before);
      await session.refresh(); release();
      expect(await pending).toMatchObject({ kind: "checked", revision: "r1", preview: "ready" });
      expect(session.status()).toMatchObject({ servingBuild: "unchanged", dirty: false, stale: false });
    } finally { release(); await session.stop(); await rm(root, { recursive: true, force: true }); }
  });

  it.each([false, true])("fences a recapture overlapped by a hint (changed=%s)", async changed => {
    let source = "first", captures = 0, entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const session = new DevSessionCore({
      capture: async () => {
        const snapshot = source; captures++;
        if (captures === 2) { entered(); await gate; }
        return { sourceRevision: snapshot, inputDigest: snapshot };
      },
      check: async () => ({ complete: true, passed: true, detail: null }),
      preparePreview: async () => preview("first", []),
    }, { debounceMs: 100_000 });
    try {
      const pending = session.check(); await started;
      if (changed) source = "second";
      session.markDirty(); release();
      expect(await pending).toMatchObject(changed ? { kind: "superseded" } : { kind: "checked", preview: "ready" });
      expect(captures).toBeGreaterThanOrEqual(3);
      expect(session.status().servingBuild).toBe(changed ? null : "first");
    } finally { release(); await session.stop(); }
  });

  it.each(["added", "deleted"] as const)("supersedes a check when a consumed input is %s", async change => {
    const root = await mkdtemp(join(tmpdir(), "can-session-membership-")), extra = join(root, "Extra.can");
    await writeFile(join(root, "App.can"), "first");
    if (change === "deleted") await writeFile(extra, "extra");
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const session = new DevSessionCore({
      capture: async () => { const names = (await readdir(root)).sort(); const bytes = await Promise.all(names.map(name => readFile(join(root, name), "utf8"))); return { sourceRevision: "first", inputDigest: JSON.stringify([names, bytes]) }; },
      check: async () => { entered(); await gate; return { complete: true, passed: true, detail: null }; },
      preparePreview: async () => preview("must-not-publish", []),
    }, { debounceMs: 100_000 });
    try {
      const pending = session.check(); await started;
      if (change === "added") await writeFile(extra, "extra"); else await rm(extra);
      session.markDirty(); release();
      expect(await pending).toMatchObject({ kind: "superseded" });
      expect(session.status().servingBuild).toBeNull();
    } finally { release(); await session.stop(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(["failure", "cancel", "stop"] as const)("refuses publication during recapture %s", async action => {
    let captures = 0, stopping: Promise<void> | undefined;
    const controller = new AbortController(), reason = new Error("recapture caller disconnected");
    const session: DevSessionCore<null, DevPreview> = new DevSessionCore({
      capture: async () => {
        captures++;
        if (captures > 1) {
          if (action === "failure") throw new Error("consumed input unreadable");
          session.markDirty();
          if (captures === 2) setImmediate(() => { if (action === "stop") stopping = session.stop(); else controller.abort(reason); });
        }
        return { sourceRevision: "first", inputDigest: "first" };
      },
      check: async () => ({ complete: true, passed: true, detail: null }),
      preparePreview: async () => preview("must-not-publish", []),
    }, { debounceMs: 100_000 });
    try {
      const pending = session.check(undefined, controller.signal);
      if (action === "cancel") await expect(pending).rejects.toBe(reason);
      else expect(await pending).toMatchObject({ kind: "superseded" });
      await stopping;
      expect(session.status().servingBuild).toBeNull();
      if (action === "failure") expect(session.status().captureError).toBe("consumed input unreadable");
    } finally { await session.stop(); }
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

describe("T14 observation boundaries", () => {
  it("reuses only the currently serving successful full-input check and keeps the final currency fence", async () => {
    let source = "same", producer = "one", checks = 0, builds = 0, mutateDuringReuse = false, reuseCaptures = 0;
    const session = new DevSessionCore({
      capture: async () => {
        if (mutateDuringReuse && ++reuseCaptures === 2) source = "changed-during-reuse";
        return { sourceRevision: source, inputDigest: `${source}:${producer}` };
      },
      check: async () => { checks++; return { complete: true, passed: true, detail: { message: "captured" } }; },
      preparePreview: async inputs => { builds++; return preview(inputs.inputDigest, []); },
    });
    try {
      await session.check();
      session.markDirty();
      expect(await session.check()).toMatchObject({ kind: "checked", revision: "r1", preview: "ready" });
      expect([checks, builds]).toEqual([1, 1]);
      producer = "two";
      expect(await session.check()).toMatchObject({ kind: "checked", revision: "r2", preview: "ready" });
      expect([checks, builds]).toEqual([2, 2]);
      mutateDuringReuse = true;
      expect(await session.check()).toMatchObject({ kind: "superseded", revision: "r2" });
      expect([checks, builds]).toEqual([2, 2]);
      expect(session.status()).toMatchObject({ servingRevision: "r2", revision: "r3", stale: true });
    } finally { await session.stop(); }
  });

  it("does not reuse failed source checks or valid checks whose preview never became ready", async () => {
    for (const sourceValid of [false, true]) {
      let checks = 0, builds = 0;
      const session = new DevSessionCore({
        capture: async () => ({ sourceRevision: "same", inputDigest: "same" }),
        check: async () => { checks++; return { complete: true, passed: sourceValid, detail: null }; },
        preparePreview: async () => { builds++; throw new Error("preview failed"); },
      });
      try {
        await session.check(); await session.check();
        expect(checks).toBe(2);
        expect(builds).toBe(sourceValid ? 2 : 0);
        expect(session.status().servingBuild).toBeNull();
      } finally { await session.stop(); }
    }
  });

  it("selects only at the final publication fence and preserves serving ownership if activation fails", async () => {
    let source = "old", failCleanup = true;
    const activated: string[] = [], disposed: string[] = [];
    const session = new DevSessionCore({
      capture: async () => ({ sourceRevision: source, inputDigest: source }),
      check: async () => ({ complete: true, passed: true, detail: null }),
      preparePreview: async inputs => {
        const id = inputs.sourceRevision;
        return { id,
          activate: () => { if (id === "new") throw new Error("selection refused"); activated.push(id); },
          dispose: async () => {
            if (id === "new" && failCleanup) throw new Error("candidate cleanup pending");
            disposed.push(id);
          },
        };
      },
    });
    try {
      await session.check();
      source = "new";
      expect(await session.check()).toMatchObject({ kind: "build_failed", error: "selection refused" });
      expect(activated).toEqual(["old"]);
      expect(session.status()).toMatchObject({ servingBuild: "old", buildRevision: "r1", cleanupRequired: true,
        lastOutcome: { source: "valid", preview: "failed" } });
      failCleanup = false;
      await session.retryCleanup();
      expect(disposed).toEqual(["new"]);
      expect(session.status()).toMatchObject({ servingBuild: "old", cleanupRequired: false });
    } finally { failCleanup = false; await session.stop(); }
    expect(disposed).toEqual(["new", "old"]);
  });

  it("distinguishes source errors from a valid source whose preview build fails while an older preview serves", async () => {
    let source = "good";
    const session = new DevSessionCore({
      capture: async () => ({ sourceRevision: source, inputDigest: source }),
      check: async inputs => ({ complete: true, passed: inputs.sourceRevision !== "invalid", detail: null }),
      preparePreview: async inputs => {
        if (inputs.sourceRevision === "build-error") throw new Error("portable producer failed");
        return preview("good-build", []);
      },
    });
    try {
      await session.check();
      const servingSequence = session.status().sequence;
      source = "invalid";
      await session.check();
      expect(session.status()).toMatchObject({
        revision: "r2", checkRevision: "r2", buildRevision: "r1", servingRevision: "r1", servingBuild: "good-build",
        lifecycle: "running", captureState: "confirmed", stale: true, operation: null,
        lastOutcome: { revision: "r2", source: "errors", preview: "unavailable", reason: null },
      });
      const invalidSequence = session.status().sequence;
      expect(invalidSequence).toBeGreaterThan(servingSequence);
      source = "build-error";
      expect(await session.check()).toMatchObject({ kind: "build_failed", revision: "r3" });
      expect(session.status()).toMatchObject({
        revision: "r3", checkRevision: "r3", buildRevision: "r1", servingRevision: "r1", servingBuild: "good-build", stale: true,
        operation: null, cleanupRequired: false,
        lastOutcome: { revision: "r3", source: "valid", preview: "failed", reason: "portable producer failed" },
      });
      expect(session.status().sequence).toBeGreaterThan(invalidSequence);
    } finally { await session.stop(); }
  });

  it("confirms identical recapture without advancing its epoch and advances tool-only changes at the same source", async () => {
    let tool = "one";
    const session = new DevSessionCore({
      capture: async () => ({ sourceRevision: "same-source", inputDigest: `same-source:${tool}` }),
      check: async () => ({ complete: true, passed: true, detail: null }),
      preparePreview: async () => preview("original-build", []),
    }, { debounceMs: 100_000 });
    try {
      await session.check();
      const initial = session.status();
      session.markDirty();
      expect(session.status()).toMatchObject({ revision: "r1", captureState: "unconfirmed", dirty: true, stale: true });
      await session.refresh();
      expect(session.status()).toMatchObject({
        revision: "r1", captureState: "confirmed", dirty: false, stale: false,
        sourceRevision: "same-source", servingRevision: "r1", servingBuild: "original-build",
      });
      expect(session.status().sequence).toBeGreaterThan(initial.sequence);
      tool = "two";
      session.markDirty(); await session.refresh();
      expect(session.status()).toMatchObject({
        revision: "r2", sourceRevision: "same-source", captureState: "confirmed", dirty: true, stale: true,
        checkRevision: "r1", servingRevision: "r1", servingBuild: "original-build",
      });
    } finally { await session.stop(); }
  });

  it("ignores a completed operation's reporter while the next operation reports its own real phase", async () => {
    let firstReporter: ((subphase: string) => void) | undefined;
    let release!: () => void, entered!: () => void, checks = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const session = new DevSessionCore({
      capture: async () => ({ sourceRevision: "source", inputDigest: "source" }),
      check: async (_inputs, _signal, report) => {
        checks++;
        if (checks === 1) firstReporter = report;
        else { report("compiler_running"); entered(); await gate; }
        return { complete: true, passed: false, detail: null };
      },
      preparePreview: async () => { throw new Error("source errors cannot build"); },
    });
    try {
      await session.check();
      const completed = session.status().lastOutcome!;
      const next = session.check(); await started;
      const checking = session.status();
      expect(checking.operation).toMatchObject({ phase: "checking_source", subphase: "compiler_running", revision: "r1" });
      expect(checking.operation!.id).not.toBe(completed.id);
      firstReporter!("stale compiler completion");
      expect(session.status().operation).toEqual(checking.operation);
      expect(session.status().sequence).toBe(checking.sequence);
      expect(session.status().lastOutcome).toEqual(completed);
      release(); await next;
      expect(session.status()).toMatchObject({ operation: null, lastOutcome: { id: checking.operation!.id, source: "errors" } });
    } finally { release(); await session.stop(); }
  });

  it("synchronously closes publication on beginStop and reports failed cleanup until a successful retry", async () => {
    let source = "old", failCleanup = true, entered!: () => void, release!: () => void;
    let buildSignal: AbortSignal | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const disposed: string[] = [];
    const session = new DevSessionCore({
      capture: async () => ({ sourceRevision: source, inputDigest: source }),
      check: async () => ({ complete: true, passed: true, detail: null }),
      preparePreview: async (inputs, _check, signal, report) => {
        if (inputs.sourceRevision === "old") return { id: "old", dispose: async () => {
          if (failCleanup) throw new Error("serving cleanup needs retry");
          disposed.push("old");
        } };
        buildSignal = signal; report("portable_bundle"); entered(); await gate;
        return preview("late", disposed);
      },
    });
    try {
      await session.check(); source = "new";
      const checking = session.check(); await started;
      expect(session.status().operation).toMatchObject({ phase: "preparing_preview", subphase: "portable_bundle" });
      session.beginStop();
      expect(buildSignal!.aborted).toBe(true);
      expect(session.status()).toMatchObject({ lifecycle: "stopping", servingBuild: "old" });
      const stopping = session.stop(), refusal = expect(stopping).rejects.toThrow("serving cleanup needs retry");
      release();
      expect(await checking).toMatchObject({ kind: "superseded" });
      await refusal;
      expect(disposed).toEqual(["late"]);
      expect(session.status()).toMatchObject({
        lifecycle: "shutdown_incomplete", cleanupRequired: true, servingBuild: null, servingRevision: null,
        operation: null, lastOutcome: { source: "superseded", preview: "superseded" },
      });
      failCleanup = false;
      await session.stop();
      expect(disposed).toEqual(["late", "old"]);
      expect(session.status()).toMatchObject({ lifecycle: "stopped", cleanupRequired: false, operation: null, servingBuild: null });
    } finally { release(); failCleanup = false; await session.stop(); }
  });
});
