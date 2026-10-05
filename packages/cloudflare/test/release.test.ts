import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION } from "@canlang/contracts";
import {
  LOCKSTEP_EXEMPT_PACKAGES,
  RELEASE_CONTRACTS_VERSION,
  RELEASE_VERSION,
  assertLockstep,
  readLockstepInputs,
  type LockstepInputs,
} from "../src/release/stamp.js";
import {
  buildDistManifest,
  verifyDistManifest,
  writeDistManifest,
} from "../src/release/manifest.js";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

function currentInputs(): LockstepInputs {
  const tree = readLockstepInputs(REPO_ROOT);
  return {
    rootVersion: tree.rootVersion,
    platformVersion: tree.packageVersions["@canlang/cloudflare"] as string,
    compilerVersion: tree.compilerVersion,
    contractsVersion: CONTRACTS_VERSION,
    packageVersions: tree.packageVersions,
  };
}

describe("release stamp (B5-J3)", () => {
  it("pins the release version constants", () => {
    expect(RELEASE_VERSION).toBe("0.1.0");
    expect(RELEASE_CONTRACTS_VERSION).toBe(1);
    expect(LOCKSTEP_EXEMPT_PACKAGES).toEqual({
      "@canlang/files": "0.0.0",
      "@canlang/services": "0.0.0",
      "@canlang/work": "0.0.0",
    });
  });

  it("assertLockstep passes on the current tree (no bumps)", () => {
    expect(() => assertLockstep(currentInputs())).not.toThrow();
  });

  it("assertLockstep fails loud with the full drift list", () => {
    const inputs = currentInputs();
    const drifted: LockstepInputs = {
      ...inputs,
      platformVersion: "9.9.9",
      contractsVersion: 99,
      packageVersions: { ...inputs.packageVersions, "@canlang/values": "9.9.9" },
    };
    let message = "";
    try {
      assertLockstep(drifted);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("release lockstep");
    expect(message).toContain("platform");
    expect(message).toContain("contracts");
    expect(message).toContain("@canlang/values");
  });

  it("assertLockstep rejects an exempt package at an unexpected version", () => {
    const inputs = currentInputs();
    const drifted: LockstepInputs = {
      ...inputs,
      packageVersions: { ...inputs.packageVersions, "@canlang/files": "0.2.0" },
    };
    expect(() => assertLockstep(drifted)).toThrow(/@canlang\/files/);
  });
});

describe("dist manifest (B5-J3)", () => {
  function fixtureDist(): { root: string; dist: string } {
    const root = mkdtempSync(join(tmpdir(), "can-manifest-"));
    const dist = join(root, "packages", "demo", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.js"), "export const x = 1;\n");
    writeFileSync(join(dist, "index.d.ts"), "export declare const x = 1;\n");
    // Composite tsbuildinfo carries timestamps: covered but must not break determinism.
    writeFileSync(join(dist, "demo.tsbuildinfo"), JSON.stringify({ time: Date.now() }));
    return { root, dist };
  }

  it("round-trips: build -> write -> verify passes", () => {
    const { root } = fixtureDist();
    const manifest = buildDistManifest(root, ["packages/demo/dist"]);
    expect(manifest.release).toBe(RELEASE_VERSION);
    expect(manifest.files.length).toBeGreaterThan(0);
    const manifestPath = writeDistManifest(root, manifest);
    expect(() => verifyDistManifest(root, manifestPath)).not.toThrow();
  });

  it("is deterministic across rebuilds (tsbuildinfo excluded)", () => {
    const { root } = fixtureDist();
    const first = buildDistManifest(root, ["packages/demo/dist"]);
    // Simulate a rebuild: only the timestamped tsbuildinfo changes.
    writeFileSync(
      join(root, "packages", "demo", "dist", "demo.tsbuildinfo"),
      JSON.stringify({ time: Date.now() + 1000 }),
    );
    const second = buildDistManifest(root, ["packages/demo/dist"]);
    expect(second).toEqual(first);
    expect(first.files.some((file) => file.path.endsWith(".tsbuildinfo"))).toBe(false);
  });

  it("verify fails loud naming the tampered file", () => {
    const { root } = fixtureDist();
    const manifest = buildDistManifest(root, ["packages/demo/dist"]);
    const manifestPath = writeDistManifest(root, manifest);
    writeFileSync(join(root, "packages", "demo", "dist", "index.js"), "export const x = 2;\n");
    expect(() => verifyDistManifest(root, manifestPath)).toThrow(/index\.js/);
  });

  it("verify fails loud on a missing file", () => {
    const { root } = fixtureDist();
    const manifest = buildDistManifest(root, ["packages/demo/dist"]);
    const manifestPath = writeDistManifest(root, manifest);
    rmSync(join(root, "packages", "demo", "dist", "index.d.ts"));
    expect(() => verifyDistManifest(root, manifestPath)).toThrow(/index\.d\.ts/);
  });
});
