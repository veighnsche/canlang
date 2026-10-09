import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureIsCurrent,
  captureSingleFileSource,
  verifyCompilerSources,
  type SingleFileCaptureRequest,
} from "../src/dev/source-capture.js";

function fixture(): SingleFileCaptureRequest {
  const checkoutRoot = mkdtempSync(join(tmpdir(), "can-source-capture-"));
  writeFileSync(join(checkoutRoot, "app.can"), "app Office\r\nGiven\r\nWhen\r\nThen\r\n");
  writeFileSync(join(checkoutRoot, "compiler"), "compiler build A");
  writeFileSync(join(checkoutRoot, "catalog.json"), "catalog A");
  writeFileSync(join(checkoutRoot, "help.json"), "help A");
  writeFileSync(join(checkoutRoot, "runtime.js"), "runtime A");
  return {
    checkoutRoot,
    appPath: "app.can",
    profile: "office-supplies-v1",
    compilerPath: join(checkoutRoot, "compiler"),
    catalogPath: join(checkoutRoot, "catalog.json"),
    helpIndexPath: join(checkoutRoot, "help.json"),
    packageInputPaths: [{ name: "runtime", path: join(checkoutRoot, "runtime.js") }],
    semanticOptions: { mode: "local" },
  };
}

describe("one-file source capture", () => {
  it("keeps exact source bytes and separates source from non-source revisions", async () => {
    const request = fixture();
    const first = await captureSingleFileSource(request);
    expect(first.compilerOperand).toBe("app.can");
    expect(first.sourceText).toContain("\r\n");
    expect(first.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await captureIsCurrent(first)).toBe(true);
    writeFileSync(request.catalogPath!, "catalog B");
    const catalogChanged = await captureSingleFileSource(request);
    expect(catalogChanged.sourceRevision).toBe(first.sourceRevision);
    expect(catalogChanged.epochMaterial).not.toBe(first.epochMaterial);
    expect(await captureIsCurrent(first)).toBe(false);
    for (const inputPath of [request.compilerPath, request.helpIndexPath, request.packageInputPaths[0]!.path]) {
      const prior = await captureSingleFileSource(request);
      writeFileSync(inputPath, `changed ${inputPath}`);
      const next = await captureSingleFileSource(request);
      expect(next.sourceRevision).toBe(prior.sourceRevision);
      expect(next.epochMaterial).not.toBe(prior.epochMaterial);
    }
    writeFileSync(join(request.checkoutRoot, "app.can"), "app Office\nGiven\nWhen\nThen\n");
    const sourceChanged = await captureSingleFileSource(request);
    expect(sourceChanged.sourceRevision).not.toBe(first.sourceRevision);
  });

  it("admits an in-root symlink but refuses one escaping the checkout", async () => {
    const request = fixture();
    mkdirSync(join(request.checkoutRoot, "src"));
    writeFileSync(join(request.checkoutRoot, "src", "real.can"), "app InRoot\n");
    symlinkSync(join(request.checkoutRoot, "src", "real.can"), join(request.checkoutRoot, "link.can"));
    const inRoot = await captureSingleFileSource({ ...request, appPath: "link.can" });
    expect(inRoot.compilerOperand).toBe("src/real.can");
    const outside = mkdtempSync(join(tmpdir(), "can-source-outside-"));
    writeFileSync(join(outside, "external.can"), "app Escaped\n");
    symlinkSync(join(outside, "external.can"), join(request.checkoutRoot, "escape.can"));
    await expect(captureSingleFileSource({ ...request, appPath: "escape.can" })).rejects.toThrow(/escapes checkout/);
  });

  it("requires complete, exact one-file compiler membership and hash", async () => {
    const capture = await captureSingleFileSource(fixture());
    const source = { path: capture.compilerOperand, sha256: capture.sourceSha256 };
    expect(verifyCompilerSources(capture, { complete: true, sources: [source] })).toEqual({ ok: true });
    expect(verifyCompilerSources(capture, { complete: false, sources: [source] })).toEqual({ ok: false, reason: "analysis_incomplete" });
    expect(verifyCompilerSources(capture, { complete: true, sources: [source, source] })).toEqual({ ok: false, reason: "source_membership_mismatch" });
    expect(verifyCompilerSources(capture, { complete: true, sources: [{ ...source, path: "other.can" }] })).toEqual({ ok: false, reason: "source_path_mismatch" });
    expect(verifyCompilerSources(capture, { complete: true, sources: [{ ...source, sha256: "a".repeat(64) }] })).toEqual({ ok: false, reason: "source_hash_mismatch" });
  });

  it("marks a capture stale when its app symlink target changes", async () => {
    const request = fixture();
    const link = join(request.checkoutRoot, "link.can");
    symlinkSync(join(request.checkoutRoot, "app.can"), link);
    const capture = await captureSingleFileSource({ ...request, appPath: "link.can" });
    writeFileSync(join(request.checkoutRoot, "other.can"), "app Other\n");
    unlinkSync(link);
    symlinkSync(join(request.checkoutRoot, "other.can"), link);
    expect(await captureIsCurrent(capture)).toBe(false);
  });

  it("pins relative infrastructure paths to the selected checkout", async () => {
    const request = fixture();
    const relative = {
      ...request,
      compilerPath: "compiler",
      catalogPath: "catalog.json",
      helpIndexPath: "help.json",
      packageInputPaths: [{ name: "runtime", path: "runtime.js" }],
    };
    const capture = await captureSingleFileSource(relative);
    expect(capture.inputs.find(input => input.name === "compiler")?.requestedPath)
      .toBe(join(capture.root, "compiler"));
    expect(await captureIsCurrent(capture)).toBe(true);
  });
});
