import { describe, expect, it } from "vitest";
import { DevRevisionConflictError, DevSessionCore, type DevPreview } from "../src/dev/session-core.js";

function preview(id: string, disposed: string[]): DevPreview {
  return { id, dispose: async () => { disposed.push(id); } };
}

describe("development session revision lifecycle", () => {
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
});
