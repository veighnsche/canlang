import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  captureIsCurrent,
  captureSingleFileSource,
  capturedRuntimeInputsAreCurrent,
  capturedProducerInputsAreCurrent,
  verifyCompilerSources,
  type SingleFileCaptureRequest,
} from "../src/dev/source-capture.js";

const installedInventory = vi.hoisted(() => ({
  packageInputPaths: [] as Array<{ name: string; path: string }>,
  extraInputPaths: [] as Array<{ name: string; path: string }>,
  browserQualificationInputPaths: [] as Array<{ name: string; path: string }>,
  stale: false,
}));
vi.mock("../src/dev/preview-inputs.js", () => ({
  installedBrowserQualificationInputs: async () => installedInventory.browserQualificationInputPaths,
  installedLocalPreviewInputInventory: () => {
    if (installedInventory.stale) throw new Error("installed outputs are older than source");
    return { packageInputPaths: installedInventory.packageInputPaths,
      extraInputPaths: installedInventory.extraInputPaths };
  },
  installedPortableBundleInputs: () => {
    if (installedInventory.stale) throw new Error("installed outputs are older than source");
    return installedInventory.packageInputPaths;
  },
  installedOwnedSourceInputs: () => {
    if (installedInventory.stale) throw new Error("installed outputs are older than source");
    return installedInventory.extraInputPaths.filter(item => item.name.startsWith("source:"));
  },
}));

function fixture(): SingleFileCaptureRequest {
  installedInventory.browserQualificationInputPaths = [];
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
  it("retains runtime identity after a source edit and refuses changed producers", async () => {
    const request = fixture();
    const first = await captureSingleFileSource(request);
    writeFileSync(join(request.checkoutRoot, "app.can"), "app Office\n## Changed source.\n");
    expect(await captureIsCurrent(first)).toBe(false);
    expect(await capturedRuntimeInputsAreCurrent(first)).toBe(true);
    expect(await capturedProducerInputsAreCurrent(first)).toBe(true);
    writeFileSync(request.packageInputPaths[0]!.path, "changed installed producer");
    expect(await capturedRuntimeInputsAreCurrent(first)).toBe(false);
    expect(await capturedProducerInputsAreCurrent(first)).toBe(false);
  });
  it("keeps runtime currency independent from analysis-only inputs", async () => {
    const request = fixture();
    const grammarPath = join(request.checkoutRoot, "grammar.json");
    writeFileSync(grammarPath, "grammar A");
    const capture = await captureSingleFileSource({
      ...request,
      extraInputPaths: [{ name: "grammar:main", path: grammarPath }],
    });

    writeFileSync(join(request.checkoutRoot, "app.can"), "app Office\n## Edited app.\n");
    expect(await capturedRuntimeInputsAreCurrent(capture)).toBe(true);
    expect(await capturedProducerInputsAreCurrent(capture)).toBe(true);
    for (const path of [request.compilerPath, request.catalogPath!, request.helpIndexPath, grammarPath]) {
      const producerCapture = await captureSingleFileSource({ ...request,
        extraInputPaths: [{name:"grammar:main",path:grammarPath}] });
      writeFileSync(path, `analysis-only change ${path}`);
      expect(await capturedRuntimeInputsAreCurrent(capture)).toBe(true);
      expect(await capturedProducerInputsAreCurrent(producerCapture)).toBe(false);
    }
    writeFileSync(request.packageInputPaths[0]!.path, "changed runtime output");
    expect(await capturedRuntimeInputsAreCurrent(capture)).toBe(false);
  });
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

  it("keeps sorted identities and digest stable across more than one reader group", async () => {
    const request = fixture();
    const packages = Array.from({ length: 24 }, (_, index) => {
      const name = `package-${String(23 - index).padStart(2, "0")}`;
      const path = join(request.checkoutRoot, `${name}.js`);
      writeFileSync(path, `output ${name}`);
      return { name, path };
    });
    const selected = { ...request, packageInputPaths: packages };
    const first = await captureSingleFileSource(selected);
    const second = await captureSingleFileSource(selected);
    expect(first.inputs.map(input => input.name)).toEqual(
      [...first.inputs.map(input => input.name)].sort((a, b) => a.localeCompare(b)));
    expect(first.inputs).toEqual(second.inputs);
    expect(first.epochMaterial).toBe(second.epochMaterial);
    expect(await captureIsCurrent(first)).toBe(true);
    writeFileSync(packages[18]!.path, "changed output");
    expect(await capturedRuntimeInputsAreCurrent(first)).toBe(false);
  });

  it("rediscovers installed output and source membership, including additions and removals", async () => {
    const request = fixture();
    const sourcePath = join(request.checkoutRoot, "runtime.ts");
    const compilerSourcePath = join(request.checkoutRoot, "compiler-source.rs");
    writeFileSync(sourcePath, "source A");
    writeFileSync(compilerSourcePath, "compiler source A");
    installedInventory.packageInputPaths = [...request.packageInputPaths];
    installedInventory.extraInputPaths = [
      { name: "source:runtime", path: sourcePath },
      { name: "compiler-source:main", path: compilerSourcePath },
    ];
    installedInventory.stale = false;
    try {
      const installedRequest = { ...request, extraInputPaths: installedInventory.extraInputPaths,
        inputInventory: "installed-local-preview" as const };
      const first = await captureSingleFileSource(installedRequest);
      expect(await captureIsCurrent(first)).toBe(true);
      writeFileSync(sourcePath, "runtime source B");
      expect(await capturedRuntimeInputsAreCurrent(first)).toBe(false);
      writeFileSync(sourcePath, "source A");
      const addedCompilerPath = join(request.checkoutRoot, "compiler-source-new.rs");
      writeFileSync(addedCompilerPath, "compiler source B");
      installedInventory.extraInputPaths = [
        ...installedInventory.extraInputPaths,
        { name: "compiler-source:new", path: addedCompilerPath },
      ];
      expect(await capturedRuntimeInputsAreCurrent(first)).toBe(true);
      expect(await captureIsCurrent(first)).toBe(false);
      installedInventory.extraInputPaths = [
        { name: "source:runtime", path: sourcePath },
        { name: "compiler-source:main", path: compilerSourcePath },
      ];
      const addedPath = join(request.checkoutRoot, "new-runtime.js");
      writeFileSync(addedPath, "new output");
      installedInventory.packageInputPaths = [...request.packageInputPaths, { name: "new", path: addedPath }];
      expect(await captureIsCurrent(first)).toBe(false);
      expect(await capturedRuntimeInputsAreCurrent(first)).toBe(false);
      await expect(captureSingleFileSource(installedRequest)).rejects.toThrow(/membership changed/);
      const withAddition = await captureSingleFileSource({ ...installedRequest,
        packageInputPaths: installedInventory.packageInputPaths });
      expect(withAddition.epochMaterial).not.toBe(first.epochMaterial);
      installedInventory.packageInputPaths = [];
      expect(await captureIsCurrent(withAddition)).toBe(false);
      installedInventory.packageInputPaths = [...request.packageInputPaths];
      installedInventory.extraInputPaths = [];
      expect(await captureIsCurrent(first)).toBe(false);
      installedInventory.extraInputPaths = [
        { name: "source:runtime", path: sourcePath },
        { name: "compiler-source:main", path: compilerSourcePath },
      ];
      const addedSourcePath = join(request.checkoutRoot, "runtime-source-new.ts");
      writeFileSync(addedSourcePath, "source B");
      installedInventory.extraInputPaths = [
        ...installedInventory.extraInputPaths,
        { name: "source:new", path: addedSourcePath },
      ];
      expect(await captureIsCurrent(first)).toBe(false);
      expect(await capturedRuntimeInputsAreCurrent(first)).toBe(false);
      installedInventory.stale = true;
      expect(await captureIsCurrent(first)).toBe(false);
    } finally {
      installedInventory.packageInputPaths = [];
      installedInventory.extraInputPaths = [];
      installedInventory.browserQualificationInputPaths = [];
      installedInventory.stale = false;
    }
  });

  it("refuses a retained source input after its installed symlink alias changes", async () => {
    const request = fixture();
    const firstTarget = join(request.checkoutRoot, "source-a.ts");
    const nextTarget = join(request.checkoutRoot, "source-b.ts");
    const alias = join(request.checkoutRoot, "runtime-source.ts");
    writeFileSync(firstTarget, "same source bytes");
    writeFileSync(nextTarget, "same source bytes");
    symlinkSync(firstTarget, alias);
    installedInventory.packageInputPaths = [...request.packageInputPaths];
    installedInventory.extraInputPaths = [{ name: "source:runtime", path: alias }];
    installedInventory.stale = false;
    try {
      const capture = await captureSingleFileSource({
        ...request,
        extraInputPaths: installedInventory.extraInputPaths,
        inputInventory: "installed-local-preview",
      });
      unlinkSync(alias);
      symlinkSync(nextTarget, alias);
      expect(await capturedRuntimeInputsAreCurrent(capture)).toBe(false);
    } finally {
      installedInventory.packageInputPaths = [];
      installedInventory.extraInputPaths = [];
      installedInventory.browserQualificationInputPaths = [];
      installedInventory.stale = false;
    }
  });

  it("tracks optional browser membership and resources without changing portable runtime currency", async () => {
    const request = fixture();
    installedInventory.packageInputPaths = [...request.packageInputPaths];
    installedInventory.extraInputPaths = [];
    const selected = { ...request, inputInventory: "installed-local-preview" as const };
    try {
      const absent = await captureSingleFileSource(selected);
      expect(await captureIsCurrent(absent)).toBe(true);
      const executable = join(request.checkoutRoot, "chromium");
      const resource = join(request.checkoutRoot, "resources.pak");
      const alias = join(request.checkoutRoot, "selected-resource.pak");
      const resourceBytes = Buffer.alloc(600 * 1024, 0x37);
      writeFileSync(executable, "actual fixture executable bytes");
      writeFileSync(resource, resourceBytes);
      symlinkSync(resource, alias);
      installedInventory.browserQualificationInputPaths = [
        { name: "browser:executable", path: executable },
        { name: "browser:resource", path: alias },
      ];
      expect(await capturedProducerInputsAreCurrent(absent)).toBe(false);
      expect(await captureIsCurrent(absent)).toBe(false);
      expect(await capturedRuntimeInputsAreCurrent(absent)).toBe(true);
      const installed = await captureSingleFileSource(selected);
      expect(installed.epochMaterial).not.toBe(absent.epochMaterial);
      expect(installed.sourceRevision).toBe(absent.sourceRevision);
      expect(installed.inputs.find(input=>input.name==="extra:browser:resource")?.sha256)
        .toBe(createHash("sha256").update(resourceBytes).digest("hex"));
      expect(await captureIsCurrent(installed)).toBe(true);
      resourceBytes.writeUInt8(resourceBytes.readUInt8(resourceBytes.length - 1) ^ 1, resourceBytes.length - 1);
      writeFileSync(resource, resourceBytes);
      expect(await capturedProducerInputsAreCurrent(installed)).toBe(false);
      expect(await captureIsCurrent(installed)).toBe(false);
      expect(await capturedRuntimeInputsAreCurrent(installed)).toBe(true);
      const changed = await captureSingleFileSource(selected);
      expect(changed.epochMaterial).not.toBe(installed.epochMaterial);
      const replacement = join(request.checkoutRoot, "replacement.pak");
      writeFileSync(replacement, resourceBytes);
      unlinkSync(alias); symlinkSync(replacement, alias);
      expect(await captureIsCurrent(changed)).toBe(false);
      expect(await capturedRuntimeInputsAreCurrent(changed)).toBe(true);
      const retargeted = await captureSingleFileSource(selected);
      expect(retargeted.epochMaterial).not.toBe(changed.epochMaterial);
      const additional = join(request.checkoutRoot, "extra.dat"); writeFileSync(additional, "data");
      installedInventory.browserQualificationInputPaths.push({ name: "browser:additional", path: additional });
      expect(await capturedProducerInputsAreCurrent(retargeted)).toBe(false);
      expect(await capturedRuntimeInputsAreCurrent(retargeted)).toBe(true);
      const expanded = await captureSingleFileSource(selected);
      expect(expanded.epochMaterial).not.toBe(retargeted.epochMaterial);
      installedInventory.browserQualificationInputPaths.pop(); unlinkSync(additional);
      expect(await captureIsCurrent(expanded)).toBe(false);
      expect(await capturedRuntimeInputsAreCurrent(expanded)).toBe(true);
      installedInventory.browserQualificationInputPaths = [];
      const removed = await captureSingleFileSource(selected);
      expect(removed.epochMaterial).toBe(absent.epochMaterial);
      expect(await captureIsCurrent(removed)).toBe(true);
    } finally {
      installedInventory.packageInputPaths = [];
      installedInventory.extraInputPaths = [];
      installedInventory.browserQualificationInputPaths = [];
      installedInventory.stale = false;
      rmSync(request.checkoutRoot, { recursive: true, force: true });
    }
  });

  it.each([0, 1, 256 * 1024 - 1, 256 * 1024, 256 * 1024 + 1])(
    "hashes a %i-byte producer exactly and detects its changed contents",
    async size => {
      const request = fixture();
      try {
        const bytes = Buffer.from(Array.from({ length: size }, (_, index) => index % 251));
        const binary = join(request.checkoutRoot, "boundary.bin");
        writeFileSync(binary, bytes);
        const selected = { ...request, packageInputPaths: [{ name: "boundary", path: binary }] };
        const first = await captureSingleFileSource(selected);
        expect(first.inputs.find(input => input.name === "package:boundary")).toMatchObject({
          bytes: size, sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        expect(await captureIsCurrent(first)).toBe(true);

        const changedBytes = size === 0 ? Buffer.from([0xff]) : Buffer.from(bytes);
        changedBytes[changedBytes.length - 1] = changedBytes[changedBytes.length - 1]! ^ 0xff;
        writeFileSync(binary, changedBytes);
        expect(await captureIsCurrent(first)).toBe(false);
        const changed = await captureSingleFileSource(selected);
        expect(changed.epochMaterial).not.toBe(first.epochMaterial);
        expect(changed.inputs.find(input => input.name === "package:boundary")).toMatchObject({
          bytes: changedBytes.length, sha256: createHash("sha256").update(changedBytes).digest("hex"),
        });
      } finally { rmSync(request.checkoutRoot, { recursive: true, force: true }); }
    },
  );

  it("pins a multi-chunk binary digest and detects a same-size final-byte change", async () => {
    const request = fixture();
    try {
      const bytes = Buffer.alloc(600 * 1024, 0x61);
      const binary = join(request.checkoutRoot, "producer.bin"); writeFileSync(binary, bytes);
      const selected = { ...request, packageInputPaths: [{ name: "binary", path: binary }] };
      const first = await captureSingleFileSource(selected);
      expect(first.inputs.find(input=>input.name==="package:binary")).toMatchObject({
        bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(await capturedProducerInputsAreCurrent(first)).toBe(true);
      bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1); writeFileSync(binary, bytes);
      expect(await capturedProducerInputsAreCurrent(first)).toBe(false);
      expect(await capturedRuntimeInputsAreCurrent(first)).toBe(false);
      const changed = await captureSingleFileSource(selected);
      expect(changed.epochMaterial).not.toBe(first.epochMaterial);
      expect(changed.inputs.find(input=>input.name==="package:binary")?.sha256)
        .toBe(createHash("sha256").update(bytes).digest("hex"));
    } finally { rmSync(request.checkoutRoot, { recursive: true, force: true }); }
  });

  it("refuses an oversized sparse producer input without reading its contents", async () => {
    const request = fixture();
    try {
      const binary = join(request.checkoutRoot, "oversized.bin"); writeFileSync(binary, "");
      truncateSync(binary, 1024 * 1024 * 1024 + 1);
      await expect(captureSingleFileSource({ ...request,
        packageInputPaths: [{ name: "oversized", path: binary }],
      })).rejects.toThrow(/finite 1 GiB limit/);
    } finally { rmSync(request.checkoutRoot, { recursive: true, force: true }); }
  });

});
