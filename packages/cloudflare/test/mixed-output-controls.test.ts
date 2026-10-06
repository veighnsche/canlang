import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSET_DIGEST_V2 } from "@canlang/contracts";
import type { DeployBundle } from "../src/deploy/bundle.js";
import {
  attachBinaries,
  bundleMixedSha256,
  inventorizeAssets,
  writeDeployBundle,
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

const WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

describe("mixed output controls (corrective positives)", () => {
  it("P1: valid mixed bytes/digests round-trip exactly with a versioned manifest", () => {
    const outDir = mkdtempSync(join(tmpdir(), "can-mixed-controls-"));
    const mixed = attachBinaries(textBundle(), { "kernel.wasm": WASM });
    const written = writeDeployBundleMixed(mixed, outDir);
    expect(Buffer.from(readFileSync(join(outDir, "kernel.wasm"))).equals(Buffer.from(WASM))).toBe(true);
    expect(readFileSync(join(outDir, "worker/main.js"), "utf8")).toBe("export default {};");
    const v1 = JSON.parse(readFileSync(join(outDir, "bundle.json"), "utf8"));
    expect("digestVersion" in v1).toBe(false);
    const v2 = JSON.parse(readFileSync(join(outDir, "bundle.mixed.json"), "utf8"));
    expect(v2.digestVersion).toBe(ASSET_DIGEST_V2);
    expect(v2.mixedSha256).toBe(mixed.mixedSha256);
    expect(v2.binaries).toHaveLength(1);
    expect(v2.binaries[0]).toEqual({
      key: "kernel.wasm",
      kind: "binary",
      bytes: WASM.length,
      sha256: createHash("sha256").update(WASM).digest("hex"),
    });
    expect(v2.mixedSha256).toBe(
      bundleMixedSha256(mixed.mainModule, inventorizeAssets(mixed.modules, mixed.binaries)),
    );
    expect(written.files).toContain(join(outDir, "bundle.mixed.json"));
  });

  it("P2: exact text/binary key collision is rejected at attach", () => {
    expect(() => attachBinaries(textBundle(), { "worker/main.js": WASM })).toThrow(/collides with a text module/);
  });

  it("P3: empty binaries keep v1 text-only parity byte-identically", () => {
    const v1Dir = mkdtempSync(join(tmpdir(), "can-mixed-controls-v1-"));
    const mixedDir = mkdtempSync(join(tmpdir(), "can-mixed-controls-mixed-"));
    const bundle = textBundle();
    const v1 = writeDeployBundle(bundle, v1Dir);
    const mixed = writeDeployBundleMixed(attachBinaries(textBundle(), {}), mixedDir);
    expect(readFileSync(join(mixedDir, "worker/main.js"), "utf8")).toBe(readFileSync(join(v1Dir, "worker/main.js"), "utf8"));
    expect(readFileSync(join(mixedDir, "bundle.json"), "utf8")).toBe(readFileSync(join(v1Dir, "bundle.json"), "utf8"));
    expect(v1.files.slice().sort()).toEqual(
      mixed.files.filter((file) => !file.endsWith("bundle.mixed.json")).map((file) => file.replace(mixedDir, v1Dir)).sort(),
    );
    const v2 = JSON.parse(readFileSync(join(mixedDir, "bundle.mixed.json"), "utf8"));
    expect(v2.binaryCount).toBe(0);
    expect(v2.binaries).toEqual([]);
  });
});
