import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DeployBundle, MixedDeployBundle } from "../src/deploy/bundle.js";
import {
  attachBinaries,
  bundleMixedSha256,
  inventorizeAssets,
  writeDeployBundleMixed,
} from "../src/deploy/bundle.js";

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

/**
 * Binaries map with an own enumerable `__proto__` key. An object literal
 * `{"__proto__": ...}` would set the prototype instead of an own key;
 * defineProperty (like JSON.parse) yields the adversarial own-key shape.
 */
function ownProtoBinaries(bytes: Uint8Array): Record<string, Uint8Array> {
  const binaries: Record<string, Uint8Array> = {};
  Object.defineProperty(binaries, "__proto__", { value: bytes, enumerable: true });
  return binaries;
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
    const binaries: Record<string, Uint8Array> = { "kernel.wasm": new Uint8Array([0, 1, 2, 3]) };
    const mixed = attachBinaries(textBundle(), binaries);
    (binaries["kernel.wasm"] as Uint8Array)[0] = 99;
    binaries["evil.wasm"] = new Uint8Array([9]);
    const before = mixed.mixedSha256;
    const written = writeDeployBundleMixed(mixed, outDir);
    expect(mixed.mixedSha256).toBe(before);
    expect(written.files.some((file) => file.endsWith("evil.wasm"))).toBe(false);
  });

  it("N5a: own __proto__ binary key refuses loudly at attach (never silent loss)", () => {
    expect(() => attachBinaries(textBundle(), ownProtoBinaries(new Uint8Array([7])))).toThrow(
      /binary module key must not be "__proto__"/,
    );
  });

  it("N5b: own __proto__ binary key refuses at pre-output write, nothing written", () => {
    const outDir = freshOutDir();
    const bundle = textBundle();
    // Digest computed over the proto-less inventory so that only the
    // snapshot refusal (not a digest mismatch) can reject this bundle.
    const smuggled: MixedDeployBundle = {
      ...bundle,
      binaries: ownProtoBinaries(new Uint8Array([7])),
      mixedSha256: bundleMixedSha256(bundle.mainModule, inventorizeAssets(bundle.modules, {})),
    };
    expect(() => writeDeployBundleMixed(smuggled, outDir)).toThrow(/binary module key must not be "__proto__"/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("N5c: own __proto__ text module key refuses loudly at attach", () => {
    const modules: Record<string, string> = {};
    Object.defineProperty(modules, "__proto__", { value: "export default {};", enumerable: true });
    expect(() => attachBinaries({ ...textBundle(), modules }, {})).toThrow(
      /text module key must not be "__proto__"/,
    );
  });

  it("N5d: post-attach __proto__ assignment refuses loudly at write", () => {
    const outDir = mkdtempSync(join(tmpdir(), "can-mixed-reject-"));
    const mixed = attachBinaries(textBundle(), { "kernel.wasm": new Uint8Array([0, 1, 2, 3]) });
    mixed.binaries["__proto__"] = new Uint8Array([9]);
    expect(() => writeDeployBundleMixed(mixed, outDir)).toThrow(/binary module key must not be "__proto__"/);
  });

  it("N6: returned bundle bytes are copies — input buffer mutation cannot change them", () => {
    const input = new Uint8Array([0, 1, 2, 3]);
    const mixed = attachBinaries(textBundle(), { "kernel.wasm": input });
    input[0] = 99;
    expect(Array.from(mixed.binaries["kernel.wasm"] as Uint8Array)).toEqual([0, 1, 2, 3]);
  });

  it("C4: inherited-name keys (toString/constructor) attach and write as ordinary entries", () => {
    const outDir = mkdtempSync(join(tmpdir(), "can-mixed-reject-"));
    const mixed = attachBinaries(textBundle(), {
      toString: new Uint8Array([1]),
      constructor: new Uint8Array([2]),
    });
    const written = writeDeployBundleMixed(mixed, outDir);
    expect(written.files.some((file) => file.endsWith("toString"))).toBe(true);
    expect(written.files.some((file) => file.endsWith("constructor"))).toBe(true);
  });
});
