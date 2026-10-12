import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("never omits invalid or unreadable workspace manifests from lockstep", () => {
    const root = mkdtempSync(join(tmpdir(), "can-lockstep-"));
    try {
      mkdirSync(join(root, "compiler"));
      writeFileSync(join(root, "package.json"), JSON.stringify({ version: RELEASE_VERSION }));
      writeFileSync(join(root, "compiler", "Cargo.toml"), `[package]\nversion = "${RELEASE_VERSION}"\n`);
      const directory = join(root, "packages", "demo");
      mkdirSync(directory, { recursive: true });
      mkdirSync(join(root, "packages", "without-manifest"));
      const path = join(directory, "package.json");
      const valid = { name: "@canlang/demo", version: RELEASE_VERSION };
      for (const invalid of ["{", "null", JSON.stringify({ ...valid, version: 1 }), JSON.stringify({ version: RELEASE_VERSION })]) {
        writeFileSync(path, invalid);
        expect(() => readLockstepInputs(root)).toThrow(path);
      }
      rmSync(path);
      mkdirSync(path);
      expect(() => readLockstepInputs(root)).toThrow(path);
      rmSync(path, { recursive: true });
      symlinkSync(join(directory, "missing-package.json"), path);
      expect(() => readLockstepInputs(root)).toThrow(path);
      rmSync(path);
      writeFileSync(path, JSON.stringify(valid));
      expect(readLockstepInputs(root).packageVersions).toEqual({ "@canlang/demo": RELEASE_VERSION });
      for (const name of ["__proto__", "constructor"]) {
        writeFileSync(path, JSON.stringify({ ...valid, name }));
        const tree = readLockstepInputs(root);
        expect(Object.hasOwn(tree.packageVersions, name)).toBe(true);
        expect(tree.packageVersions[name]).toBe(RELEASE_VERSION);
        const inputs: LockstepInputs = { ...tree, platformVersion: RELEASE_VERSION, contractsVersion: RELEASE_CONTRACTS_VERSION };
        expect(() => assertLockstep(inputs)).not.toThrow();
        expect(() => assertLockstep({ ...inputs, packageVersions: { [name]: "9.9.9" } })).toThrow(name);
      }
      writeFileSync(path, JSON.stringify(valid));
      const duplicate = join(root, "packages", "duplicate");
      mkdirSync(duplicate);
      writeFileSync(join(duplicate, "package.json"), JSON.stringify({ ...valid, version: "9.9.9" }));
      expect(() => readLockstepInputs(root)).toThrow(/duplicate workspace name/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("verify rejects a false byte count with unchanged content and digest", () => {
    const { root } = fixtureDist();
    try {
      const manifest = buildDistManifest(root, ["packages/demo/dist"]);
      const original = manifest.files[0]!;
      const changed = { ...manifest, files: [{ ...original, bytes: original.bytes + 1 }, ...manifest.files.slice(1)] };
      const manifestPath = writeDistManifest(root, changed);
      expect(() => verifyDistManifest(root, manifestPath)).toThrow(
        `changed: ${original.path} (bytes ${original.bytes + 1} -> ${original.bytes})`,
      );
      writeDistManifest(root, manifest);
      expect(() => verifyDistManifest(root, manifestPath)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps overlapping captures unique and refuses hidden duplicate claims", () => {
    const { root, dist } = fixtureDist();
    try {
      mkdirSync(join(dist, "nested"));
      writeFileSync(join(dist, "nested", "entry.js"), "export const nested = true;\n");
      const manifest = buildDistManifest(root, [
        "packages/demo/dist",
        "packages/demo/dist/nested",
        "packages/demo/dist",
      ]);
      expect(manifest.roots).toEqual(["packages/demo/dist", "packages/demo/dist/nested"]);
      expect(new Set(manifest.files.map((file) => file.path)).size).toBe(manifest.files.length);
      const manifestPath = writeDistManifest(root, manifest);
      expect(() => verifyDistManifest(root, manifestPath)).not.toThrow();
      const original = manifest.files[0]!;
      for (const duplicate of [original, { ...original, sha256: "0".repeat(64), bytes: original.bytes + 1 }]) {
        writeDistManifest(root, { ...manifest, files: [duplicate, ...manifest.files] });
        expect(() => verifyDistManifest(root, manifestPath)).toThrow(`duplicate: ${original.path}`);
      }
      const missing = manifest.files[1]!;
      rmSync(join(root, missing.path));
      writeFileSync(join(dist, "extra.js"), "export const extra = true;\n");
      writeDistManifest(root, {
        ...manifest,
        release: "9.9.9",
        files: [{ ...original, sha256: "0".repeat(64), bytes: original.bytes + 1 }, ...manifest.files],
      });
      let message = "";
      try {
        verifyDistManifest(root, manifestPath);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("release: manifest pins 9.9.9");
      expect(message).toContain(`duplicate: ${original.path}`);
      expect(message).toContain(`changed: ${original.path}`);
      expect(message).toContain(`missing: ${missing.path}`);
      expect(message).toContain("unexpected: packages/demo/dist/extra.js");
      writeFileSync(join(root, missing.path), "export const x = 1;\n");
      rmSync(join(dist, "extra.js"));
      writeDistManifest(root, manifest);
      expect(() => verifyDistManifest(root, manifestPath)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verify fails loud on a missing file", () => {
    const { root } = fixtureDist();
    const manifest = buildDistManifest(root, ["packages/demo/dist"]);
    const manifestPath = writeDistManifest(root, manifest);
    rmSync(join(root, "packages", "demo", "dist", "index.d.ts"));
    expect(() => verifyDistManifest(root, manifestPath)).toThrow(/index\.d\.ts/);
  });
});
