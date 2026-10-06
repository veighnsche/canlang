import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DeployBundle } from "../src/deploy/bundle.js";
import { attachBinaries, writeDeployBundleMixed } from "../src/deploy/bundle.js";

function textBundle(): DeployBundle {
  const modules = { "worker/main.js": "export default {};" };
  return {
    mainModule: "worker/main.js",
    modules,
    moduleCount: 1,
    // Fixture aggregate: the mixed writer passes v1 fields through untouched;
    // correctness of the v1 digest itself is covered by deploy-bundle.test.ts.
    sha256: "v1-fixture-sha256",
    mcpBundleBytes: 0,
    httpOperationsBytes: 0,
  };
}

function freshOutDir(): string {
  return join(tmpdir(), `can-mixed-reject-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

describe("mixed output rejection (corrective negatives)", () => {
  it("N1: normalized alias worker/./main.js is rejected before any output write", () => {
    const outDir = freshOutDir();
    const mixed = attachBinaries(textBundle(), { "worker/./main.js": new Uint8Array([1, 2, 3]) });
    expect(() => writeDeployBundleMixed(mixed, outDir)).toThrow(/aliases .* after normalization/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("N2: binary bundle.json is rejected as a reserved manifest path, nothing written", () => {
    const outDir = freshOutDir();
    const mixed = attachBinaries(textBundle(), { "bundle.json": new Uint8Array([1, 2, 3]) });
    expect(() => writeDeployBundleMixed(mixed, outDir)).toThrow(/reserves writer manifest path/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("N3: binary bundle.mixed.json is rejected as a reserved manifest path, nothing written", () => {
    const outDir = freshOutDir();
    const mixed = attachBinaries(textBundle(), { "bundle.mixed.json": new Uint8Array([1, 2, 3]) });
    expect(() => writeDeployBundleMixed(mixed, outDir)).toThrow(/reserves writer manifest path/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("N4a: mutating attached binary bytes after attach fails loudly at write", () => {
    const outDir = mkdtempSync(join(tmpdir(), "can-mixed-reject-"));
    const mixed = attachBinaries(textBundle(), { "kernel.wasm": new Uint8Array([0, 1, 2, 3]) });
    (mixed.binaries["kernel.wasm"] as Uint8Array)[0] = 99;
    expect(() => writeDeployBundleMixed(mixed, outDir)).toThrow(/mixed digest mismatch/);
  });

  it("N4b: mutating the attached bundle maps after attach fails loudly at write", () => {
    const outDir = mkdtempSync(join(tmpdir(), "can-mixed-reject-"));
    const mixed = attachBinaries(textBundle(), { "kernel.wasm": new Uint8Array([0, 1, 2, 3]) });
    mixed.binaries["evil.wasm"] = new Uint8Array([9]);
    expect(() => writeDeployBundleMixed(mixed, outDir)).toThrow(/mixed digest mismatch/);
  });

  it("N4c: caller mutating attach inputs after attach cannot change the bundle", () => {
    const outDir = mkdtempSync(join(tmpdir(), "can-mixed-reject-"));
    const binaries = { "kernel.wasm": new Uint8Array([0, 1, 2, 3]) };
    const mixed = attachBinaries(textBundle(), binaries);
    (binaries["kernel.wasm"] as Uint8Array)[0] = 99;
    binaries["evil.wasm"] = new Uint8Array([9]);
    const before = mixed.mixedSha256;
    const written = writeDeployBundleMixed(mixed, outDir);
    expect(mixed.mixedSha256).toBe(before);
    expect(written.files.some((file) => file.endsWith("evil.wasm"))).toBe(false);
  });
});
