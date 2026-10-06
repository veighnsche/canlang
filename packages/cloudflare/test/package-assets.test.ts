import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { distribution as valuesDistribution } from "@canlang/values/distribution";
import { distribution as uiDistribution } from "@canlang/ui/distribution";
import {
  gatherBrowserAssets,
  gatherDeploymentAssets,
  gatherValuesWasmAssets,
} from "../src/deploy/package-assets.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "can-package-assets-"));
  temporary.push(path);
  return path;
}

function directoryUrl(path: string): URL {
  return pathToFileURL(`${path}/`);
}

function manifest(files: Record<string, string | Uint8Array>): { files: Record<string, { bytes: number; sha256: string }> } {
  const entries: Record<string, { bytes: number; sha256: string }> = {};
  for (const [name, contents] of Object.entries(files)) {
    const bytes = typeof contents === "string" ? Buffer.from(contents) : contents;
    entries[name] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  return { files: entries };
}

function writeFiles(directory: string, files: Record<string, string | Uint8Array>): void {
  mkdirSync(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(directory, name), contents);
}

const WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
function valuesFixture(): { root: string; inventory: ReturnType<typeof manifest> } {
  const root = tempDirectory();
  const files = {
    "values_semantics.js": "export const abi_version = () => 1;\n",
    "values_semantics.d.ts": "export declare function abi_version(): number;\n",
    "values_semantics_bg.wasm": WASM,
    "values_semantics_bg.wasm.d.ts": "export declare const memory: WebAssembly.Memory;\n",
  };
  writeFiles(join(root, "generated"), files);
  const inventory = manifest(files);
  writeFileSync(join(root, "generated", "BUILD.json"), JSON.stringify(inventory));
  writeFiles(root, {
    "bootstrap.js": "export { abi_version } from './generated/values_semantics.js';\n",
    "bootstrap.d.ts": "export declare const bootstrap: unknown;\n",
    "skip.test.js": "import 'node:test';\n",
    "distribution.js": "export const distribution = {};\n",
  });
  writeFiles(join(root, "nested"), { "host.js": "export const host = true;\n" });
  return { root, inventory };
}

function browserFixture(): { root: string; inventory: ReturnType<typeof manifest> } {
  const root = tempDirectory();
  const files = {
    "bootstrap.js": "import './polling.js';\n",
    "polling.js": "export const polling = true;\n",
    "can-style.css": "body { color: red; }\n",
  };
  writeFiles(root, files);
  const inventory = manifest(files);
  writeFileSync(join(root, "manifest.json"), JSON.stringify(inventory));
  return { root, inventory };
}

describe("installed package asset discovery", () => {
  it("keeps all asset selection explicit", () => {
    expect(gatherDeploymentAssets()).toEqual({ modules: {}, binaries: {}, resources: {} });
    expect(gatherDeploymentAssets({ valuesWasm: false, browser: false })).toEqual(gatherDeploymentAssets());
  });

  it("gathers raw binding modules recursively and exact WASM, excluding declarations and tests", () => {
    const { root } = valuesFixture();
    const assets = gatherValuesWasmAssets(directoryUrl(root));
    expect(Object.keys(assets.modules)).toEqual([
      "vendor/values-bindings/bootstrap.js",
      "vendor/values-bindings/generated/values_semantics.js",
      "vendor/values-bindings/nested/host.js",
    ]);
    expect(assets.modules["vendor/values-bindings/bootstrap.js"]).toBe(readFileSync(join(root, "bootstrap.js"), "utf8"));
    expect(assets.binaries).toEqual({ "vendor/values-bindings/generated/values_semantics_bg.wasm": WASM });
    expect(assets.resources).toEqual({});
  });

  it("keeps browser JS/CSS outside Worker modules and preserves bytes and MIME", () => {
    const { root } = browserFixture();
    const assets = gatherBrowserAssets(directoryUrl(root));
    expect(assets.modules).toEqual({});
    expect(assets.binaries).toEqual({});
    expect(Object.keys(assets.resources)).toEqual(["browser/bootstrap.js", "browser/can-style.css", "browser/polling.js"]);
    for (const [key, resource] of Object.entries(assets.resources)) {
      expect(Buffer.from(resource.bytes)).toEqual(readFileSync(join(root, key.slice("browser/".length))));
      expect(resource.contentType).toBe(key.endsWith(".css") ? "text/css" : "application/javascript");
    }
  });

  it.each(["values_semantics.js", "values_semantics.d.ts", "values_semantics_bg.wasm", "values_semantics_bg.wasm.d.ts"])(
    "rejects corrupt generated %s, including declarations that are not staged",
    (name) => {
      const { root } = valuesFixture();
      writeFileSync(join(root, "generated", name), "corrupt");
      expect(() => gatherValuesWasmAssets(directoryUrl(root))).toThrow(/integrity mismatch/);
    },
  );

  it("rejects a missing generated WASM file", () => {
    const { root } = valuesFixture();
    rmSync(join(root, "generated", "values_semantics_bg.wasm"));
    expect(() => gatherValuesWasmAssets(directoryUrl(root))).toThrow(/missing asset/);
  });

  it("rejects manifest file-set changes before following a traversal path", () => {
    const { root, inventory } = browserFixture();
    inventory.files["../outside.js"] = inventory.files["bootstrap.js"]!;
    delete inventory.files["bootstrap.js"];
    writeFileSync(join(root, "manifest.json"), JSON.stringify(inventory));
    expect(() => gatherBrowserAssets(directoryUrl(root))).toThrow(/manifest file set/);
  });

  it("rejects unknown generated files and malformed integrity metadata", () => {
    const { root, inventory } = valuesFixture();
    inventory.files["unreviewed.js"] = { bytes: 0, sha256: "0".repeat(64) };
    writeFileSync(join(root, "generated", "BUILD.json"), JSON.stringify(inventory));
    expect(() => gatherValuesWasmAssets(directoryUrl(root))).toThrow(/manifest file set/);
    delete inventory.files["unreviewed.js"];
    inventory.files["values_semantics.js"]!.bytes = -1;
    writeFileSync(join(root, "generated", "BUILD.json"), JSON.stringify(inventory));
    expect(() => gatherValuesWasmAssets(directoryUrl(root))).toThrow(/malformed integrity entry/);
  });

  it("rejects browser corruption, missing files, and unreadable manifests", () => {
    const { root } = browserFixture();
    writeFileSync(join(root, "can-style.css"), "corrupt");
    expect(() => gatherBrowserAssets(directoryUrl(root))).toThrow(/integrity mismatch/);
    rmSync(join(root, "bootstrap.js"));
    expect(() => gatherBrowserAssets(directoryUrl(root))).toThrow(/missing asset/);
    writeFileSync(join(root, "manifest.json"), "{");
    expect(() => gatherBrowserAssets(directoryUrl(root))).toThrow(/cannot read manifest/);
  });

  it("rejects symlink escapes even when external bytes match the manifest", () => {
    const { root } = browserFixture();
    const external = join(tempDirectory(), "bootstrap.js");
    writeFileSync(external, readFileSync(join(root, "bootstrap.js")));
    rmSync(join(root, "bootstrap.js"));
    symlinkSync(external, join(root, "bootstrap.js"));
    expect(() => gatherBrowserAssets(directoryUrl(root))).toThrow(/escapes producer directory/);
  });

  it("rejects escaping host modules outside the pinned generated subset", () => {
    const { root } = valuesFixture();
    const external = join(tempDirectory(), "host.js");
    writeFileSync(external, "export const host = true;");
    symlinkSync(external, join(root, "escape.js"));
    expect(() => gatherValuesWasmAssets(directoryUrl(root))).toThrow(/escapes producer directory/);
  });

  it("reads real installed producer bytes through exported locations", () => {
    const selected = gatherDeploymentAssets({ valuesWasm: true, browser: true });
    expect(Buffer.from(selected.binaries["vendor/values-bindings/generated/values_semantics_bg.wasm"]!))
      .toEqual(readFileSync(new URL("generated/values_semantics_bg.wasm", valuesDistribution.bindings)));
    expect(selected.modules["vendor/values-bindings/bootstrap.js"])
      .toBe(readFileSync(new URL("bootstrap.js", valuesDistribution.bindings), "utf8"));
    expect(Buffer.from(selected.resources["browser/can-style.css"]!.bytes))
      .toEqual(readFileSync(new URL("can-style.css", uiDistribution.browser)));
    expect(selected.modules["browser/can-style.css"]).toBeUndefined();
  });
});
