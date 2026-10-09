import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachBinaries, bundleSha256, sha256Bytes,
  writeDeployBundleMixed, writeDeployBundleWithAssets,
} from "../src/deploy/bundle.js";
import type { DeployBundle, MixedDeployBundle } from "../src/deploy/bundle.js";
import { createHash } from "node:crypto";

const bytes = new Uint8Array([0, 255, 128, 1]);
function text(): DeployBundle {
  const modules = { "a.js": "EARLY", "worker/main.js": "export default {};" };
  return {
    mainModule: "worker/main.js", modules,
    moduleCount: 2, sha256: bundleSha256("worker/main.js", modules), mcpBundleBytes: 0, httpOperationsBytes: 0,
  };
}
function mixed(): MixedDeployBundle { return attachBinaries(text(), { "binary/kernel.wasm": bytes }); }
function withScratch(check: (output: string, outside: string) => void): void {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "can-mixed-contained-")));
  const outside = join(scratch, "outside"); mkdirSync(outside);
  try { check(join(scratch, "output"), outside); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}

describe("mixed output containment", () => {
  it.each(["absent", "existing"])("keeps successful bytes, manifests and sorted paths for %s output", (state) => {
    withScratch((output, outside) => {
      if (state === "existing") {
        mkdirSync(join(output, "binary"), { recursive: true });
        writeFileSync(join(output, "binary/kernel.wasm"), "old selected bytes");
        writeFileSync(join(output, "keep"), "unselected");
      }
      const selected = mixed(), first = writeDeployBundleMixed(selected, output);
      const manifest = readFileSync(join(output, "bundle.mixed.json"), "utf8");
      const textManifest = readFileSync(join(output, "bundle.json"), "utf8");
      expect([...readFileSync(join(output, "binary/kernel.wasm"))]).toEqual([...bytes]);
      expect(readFileSync(join(output, "a.js"), "utf8")).toBe("EARLY");
      expect(first).toEqual({ dir: output, mainFile: join(output, "worker/main.js"), files: [
        join(output, "a.js"), join(output, "binary/kernel.wasm"), join(output, "bundle.json"),
        join(output, "bundle.mixed.json"), join(output, "worker/main.js"),
      ] });
      expect(JSON.parse(manifest)).toMatchObject({ mixedSha256: selected.mixedSha256, binaryCount: 1,
        binaries: [{ key: "binary/kernel.wasm", kind: "binary", bytes: bytes.length, sha256: sha256Bytes(bytes) }] });
      expect(writeDeployBundleMixed(selected, output)).toEqual(first);
      expect(readFileSync(join(output, "bundle.mixed.json"), "utf8")).toBe(manifest);
      expect(readFileSync(join(output, "bundle.json"), "utf8")).toBe(textManifest);
      if (state === "existing") expect(readFileSync(join(output, "keep"), "utf8")).toBe("unselected");
      expect(readdirSync(outside)).toEqual([]);
    });
  });

  it.each(["final", "intermediate", "dangling final", "dangling intermediate", "manifest", "dangling manifest"])(
    "refuses a binary-only %s symlink before any selected text write", (placement) => {
      withScratch((output, outside) => {
        mkdirSync(output); writeFileSync(join(output, "a.js"), "prior producer bytes");
        const sentinel = join(outside, "sentinel"); writeFileSync(sentinel, "outside bytes");
        if (placement.includes("manifest")) {
          symlinkSync(join(outside, placement === "manifest" ? "sentinel" : "missing"), join(output, "bundle.mixed.json"));
        } else if (placement.includes("intermediate")) {
          symlinkSync(placement === "intermediate" ? outside : join(outside, "missing"), join(output, "binary"));
        } else {
          mkdirSync(join(output, "binary"));
          symlinkSync(join(outside, placement === "final" ? "sentinel" : "missing"), join(output, "binary/kernel.wasm"));
        }
        const before = readdirSync(output).sort(), outsideBefore = readdirSync(outside).sort();
        expect(() => writeDeployBundleMixed(mixed(), output)).toThrow(/output symlink/);
        expect(readFileSync(join(output, "a.js"), "utf8")).toBe("prior producer bytes");
        expect(readFileSync(sentinel, "utf8")).toBe("outside bytes");
        expect(readdirSync(output).sort()).toEqual(before);
        expect(readdirSync(outside).sort()).toEqual(outsideBefore);
        expect(existsSync(join(output, "worker"))).toBe(false);
        expect(existsSync(join(output, "bundle.json"))).toBe(false);
      });
    },
  );

  it.each(["text symlink", "text manifest", "binary collision", "manifest collision"])(
    "refuses a selected %s before overwriting prior text", (placement) => {
      withScratch((output, outside) => {
        mkdirSync(output); writeFileSync(join(output, "a.js"), "prior producer bytes");
        writeFileSync(join(outside, "sentinel"), "outside bytes");
        if (placement === "text symlink") {
          mkdirSync(join(output, "worker")); symlinkSync(join(outside, "sentinel"), join(output, "worker/main.js"));
        } else if (placement === "text manifest") symlinkSync(join(outside, "sentinel"), join(output, "bundle.json"));
        else if (placement === "binary collision") mkdirSync(join(output, "binary/kernel.wasm"), { recursive: true });
        else mkdirSync(join(output, "bundle.mixed.json"));
        expect(() => writeDeployBundleMixed(mixed(), output)).toThrow(/output symlink|file\/directory collision/);
        expect(readFileSync(join(output, "a.js"), "utf8")).toBe("prior producer bytes");
        expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside bytes");
      });
    },
  );

  it.each(["snapshot", "text layout", "layout", "digest"])("preserves the %s failure before filesystem refusal", (phase) => {
    withScratch((output, outside) => {
      mkdirSync(output); writeFileSync(join(output, "a.js"), "prior producer bytes");
      writeFileSync(join(outside, "sentinel"), "outside bytes");
      symlinkSync(join(outside, "sentinel"), join(output, "bundle.mixed.json"));
      const selected = mixed();
      if (phase === "snapshot") Object.defineProperty(selected.binaries, "__proto__", { value: bytes, enumerable: true });
      else if (phase === "text layout") {
        selected.modules["../text.js"] = "invalid"; selected.binaries["../binary.bin"] = bytes;
      }
      else if (phase === "layout") selected.binaries["worker/./main.js"] = bytes;
      else selected.binaries["binary/kernel.wasm"]![0] = 90;
      expect(() => writeDeployBundleMixed(selected, output)).toThrow(
        phase === "snapshot" ? /binary module key must not be "__proto__"/ : phase === "text layout" ? /to write text module .*\.\.\/text\.js/ : phase === "layout" ? /aliases .* after normalization/ : /mixed digest mismatch/,
      );
      expect(readFileSync(join(output, "a.js"), "utf8")).toBe("prior producer bytes");
      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside bytes");
      expect(existsSync(join(output, "bundle.json"))).toBe(false);
    });
  });

  it("keeps the complete package wrapper's resource bytes and refusal behavior", () => {
    withScratch((output, outside) => {
      const resources = { "browser/app.css": { bytes: new Uint8Array([65, 66]), contentType: "text/css" } };
      const entries = [{ key: "browser/app.css", contentType: "text/css", bytes: 2, sha256: sha256Bytes(resources["browser/app.css"].bytes) }];
      const resourcesSha256 = createHash("sha256").update(JSON.stringify({ version: 1, resources: entries })).digest("hex");
      const selected = { ...mixed(), resources, resourcesSha256 };
      const written = writeDeployBundleWithAssets(selected, output);
      expect([...readFileSync(join(output, "browser/app.css"))]).toEqual([65, 66]);
      expect(written.files).toContain(join(output, "bundle.resources.json"));
      rmSync(join(output, "browser/app.css"));
      const sentinel = join(outside, "sentinel"); writeFileSync(sentinel, "outside bytes");
      symlinkSync(sentinel, join(output, "browser/app.css"));
      writeFileSync(join(output, "a.js"), "prior producer bytes");
      expect(() => writeDeployBundleWithAssets(selected, output)).toThrow(/output symlink/);
      expect(readFileSync(join(output, "a.js"), "utf8")).toBe("prior producer bytes");
      expect(readFileSync(sentinel, "utf8")).toBe("outside bytes");
    });
  });
});
