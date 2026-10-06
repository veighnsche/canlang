import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompileArtifact } from "@canlang/contracts";
import {
  assertLinksResolve,
  assertWorkerdLoadable,
  buildDeployBundle,
  buildDeployBundleWithAssets,
  writeDeployBundleWithAssets,
} from "../src/deploy/bundle.js";

const artifact: CompileArtifact = {
  artifact_version: 1,
  language_version: "1.0.0",
  tool_version: "0.1.0",
  sources: [{ path: "app.can", sha256: "0".repeat(64) }],
  modules: [{
    path: "app/main.js",
    js: "export const page = () => 'installed-assets';\n",
    map: { version: 3, file: "app.can", sources: [], sourcesContent: [], names: [], mappings: "" },
  }],
  callables: [],
  operations: [],
  pages: [{ owner: "test", path: "/", module: "app/main.js", export: "page" }],
  requires: [],
  tests: [],
};
const verdict = { active: true } as const;
const wasmKey = "vendor/values-bindings/generated/values_semantics_bg.wasm";
type AssetBundle = ReturnType<typeof buildDeployBundleWithAssets>;
let selected: AssetBundle;
const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "can-deploy-package-assets-"));
  directories.push(directory);
  return directory;
}

/** Keep corruption controls independent from the shared real producer snapshot. */
function copyBundle(): AssetBundle {
  return {
    ...selected,
    modules: { ...selected.modules },
    binaries: Object.fromEntries(Object.entries(selected.binaries).map(([key, bytes]) => [key, bytes.slice()])),
    resources: Object.fromEntries(Object.entries(selected.resources).map(([key, resource]) => [
      key, { ...resource, bytes: resource.bytes.slice() },
    ])),
  };
}

beforeAll(() => {
  selected = buildDeployBundleWithAssets(artifact, { verdict, assets: { valuesWasm: true, browser: true } });
});
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe("deploying installed package assets", () => {
  it("preserves the legacy JS map and digest when no assets are selected", () => {
    const legacy = buildDeployBundle(artifact, { verdict });
    const empty = buildDeployBundleWithAssets(artifact, { verdict });
    expect(empty.modules).toEqual(legacy.modules);
    expect(empty.sha256).toBe(legacy.sha256);
    expect(empty.moduleCount).toBe(legacy.moduleCount);
    expect(empty.binaries).toEqual({});
    expect(empty.resources).toEqual({});
  });

  it("stages a loadable real graph with values imports joined to the owning vendor modules", () => {
    expect(() => assertWorkerdLoadable(selected.modules)).not.toThrow();
    // Binary keys are graph targets, while their bytes remain outside the JS scan.
    expect(() => assertLinksResolve(selected.modules, Object.keys(selected.binaries))).not.toThrow();
    const backend = selected.modules["vendor/values-bindings/backend.js"]!;
    expect(backend).toContain("../values/int.js");
    expect(backend).not.toContain("../src/");
    expect(Object.keys(selected.binaries)).toEqual([wasmKey]);
    expect(Object.keys(selected.resources)).toEqual(["browser/bootstrap.js", "browser/can-style.css", "browser/polling.js"]);
    for (const key of Object.keys(selected.resources)) {
      expect(selected.modules[key]).toBeUndefined();
      expect(selected.binaries[key]).toBeUndefined();
    }
  });

  it("writes exact resource/WASM bytes and a deterministic resource integrity manifest", () => {
    const firstDir = tempDirectory();
    const secondDir = tempDirectory();
    const first = writeDeployBundleWithAssets(selected, firstDir);
    const second = writeDeployBundleWithAssets(copyBundle(), secondDir);
    expect(readFileSync(join(firstDir, wasmKey)).equals(Buffer.from(selected.binaries[wasmKey]!))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(firstDir, "bundle.resources.json"), "utf8"));
    expect(manifest.version).toBe(1);
    expect(manifest.resourcesSha256).toBe(selected.resourcesSha256);
    expect(manifest.resources).toEqual(Object.keys(selected.resources).sort().map((key) => {
      const resource = selected.resources[key]!;
      return {
        key,
        contentType: resource.contentType,
        bytes: resource.bytes.length,
        sha256: createHash("sha256").update(resource.bytes).digest("hex"),
      };
    }));
    expect(first.files.map((file) => file.slice(firstDir.length))).toEqual(second.files.map((file) => file.slice(secondDir.length)));
    for (const file of first.files) {
      const key = file.slice(firstDir.length + 1);
      expect(readFileSync(file).equals(readFileSync(join(secondDir, key)))).toBe(true);
    }
    for (const [key, resource] of Object.entries(selected.resources)) {
      expect(readFileSync(join(firstDir, key)).equals(Buffer.from(resource.bytes))).toBe(true);
      expect(first.files).toContain(join(firstDir, key));
    }
  });

  it("initializes the written generated glue with a precompiled module and executes exact values", () => {
    const directory = tempDirectory();
    writeDeployBundleWithAssets(selected, directory);
    // Native Node import avoids Vite transformation and exercises only written bundle files.
    const program = `
      import { readFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      import { join } from 'node:path';
      const root = process.argv[1];
      const glue = await import(pathToFileURL(join(root, 'vendor/values-bindings/generated/values_semantics.js')));
      const { wasmBackend } = await import(pathToFileURL(join(root, 'vendor/values-bindings/backend.js')));
      const module = new WebAssembly.Module(readFileSync(join(root, ${JSON.stringify(wasmKey)})));
      glue.initSync({ module });
      const backend = wasmBackend(glue);
      process.stdout.write(JSON.stringify({ abi: glue.abi_version(), backend: backend.name, sum: String(backend.call('add-int', [1n, 2n])) }));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", program, directory], { encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({ abi: 1, backend: "wasm", sum: "3" });
  });

  it.each(["bytes", "contentType", "addition", "deletion"])(
    "rejects resource %s mutation before creating output",
    (mutation) => {
      const bundle = copyBundle();
      const key = "browser/bootstrap.js";
      const resource = bundle.resources[key]!;
      if (mutation === "bytes") resource.bytes[0] = resource.bytes[0]! ^ 1;
      if (mutation === "contentType") bundle.resources[key] = { ...resource, contentType: "text/css" };
      if (mutation === "addition") bundle.resources["browser/extra.js"] = { bytes: new Uint8Array([1]), contentType: "application/javascript" };
      if (mutation === "deletion") delete bundle.resources[key];
      const output = join(tempDirectory(), "out");
      expect(() => writeDeployBundleWithAssets(bundle, output)).toThrow(/resource digest mismatch/);
      expect(existsSync(output)).toBe(false);
    },
  );

  it.each([
    ["module collision", "worker/main.js", /aliases .*after normalization/],
    ["binary collision", wasmKey, /aliases .*after normalization/],
    ["text manifest collision", "bundle.json", /reserves writer manifest path/],
    ["mixed manifest collision", "bundle.mixed.json", /reserves writer manifest path/],
    ["resource manifest collision", "bundle.resources.json", /reserves writer manifest path/],
    ["path escape", "../escape.css", /outside the module map/],
    ["normalized path alias", "browser/./bootstrap.js", /aliases .*after normalization/],
    ["file/directory collision", "browser", /file\/directory collision/],
  ] as const)("rejects %s before creating output", (_reason, key, error) => {
    const bundle = copyBundle();
    bundle.resources[key] = { bytes: new Uint8Array([1]), contentType: "text/css" };
    const output = join(tempDirectory(), "out");
    expect(() => writeDeployBundleWithAssets(bundle, output)).toThrow(error);
    expect(existsSync(output)).toBe(false);
  });

  it.each(["browser directory", "CSS file", "resource manifest", "WASM ancestor", "output directory"])(
    "rejects an existing %s symlink without touching its target or writing bundle files",
    (placement) => {
      const output = join(tempDirectory(), "out");
      const external = tempDirectory();
      const marker = new Uint8Array([0, 255, 1, 128, 42]);
      const target = join(external, "sentinel");
      writeFileSync(target, marker);
      if (placement === "output directory") {
        symlinkSync(external, output);
      } else {
        mkdirSync(output);
        if (placement === "browser directory") symlinkSync(external, join(output, "browser"));
        if (placement === "CSS file") {
          mkdirSync(join(output, "browser"));
          symlinkSync(target, join(output, "browser", "can-style.css"));
        }
        if (placement === "resource manifest") symlinkSync(target, join(output, "bundle.resources.json"));
        if (placement === "WASM ancestor") {
          mkdirSync(join(output, "vendor", "values-bindings"), { recursive: true });
          symlinkSync(external, join(output, "vendor", "values-bindings", "generated"));
        }
      }
      const existingEntries = readdirSync(output).sort();
      const existingManifests = ["bundle.json", "bundle.mixed.json", "bundle.resources.json"]
        .map((key) => existsSync(join(output, key)));
      expect(() => writeDeployBundleWithAssets(copyBundle(), output)).toThrow(/output symlink/);
      expect(readFileSync(target).equals(Buffer.from(marker))).toBe(true);
      expect(readdirSync(external)).toEqual(["sentinel"]);
      expect(readdirSync(output).sort()).toEqual(existingEntries);
      expect(existsSync(join(output, "worker", "main.js"))).toBe(false);
      expect(["bundle.json", "bundle.mixed.json", "bundle.resources.json"]
        .map((key) => existsSync(join(output, key)))).toEqual(existingManifests);
    },
  );

  it.each(["browser directory", "Worker file"])(
    "rejects an existing %s with the wrong filesystem type before writing",
    (placement) => {
      const output = tempDirectory();
      if (placement === "browser directory") {
        writeFileSync(join(output, "browser"), "existing caller file");
      } else {
        mkdirSync(join(output, "worker", "main.js"), { recursive: true });
      }
      const existingEntries = readdirSync(output).sort();
      expect(() => writeDeployBundleWithAssets(copyBundle(), output)).toThrow(/existing output has file\/directory collision/);
      expect(readdirSync(output).sort()).toEqual(existingEntries);
      for (const manifest of ["bundle.json", "bundle.mixed.json", "bundle.resources.json"]) {
        expect(existsSync(join(output, manifest))).toBe(false);
      }
      if (placement === "browser directory") {
        expect(readFileSync(join(output, "browser"), "utf8")).toBe("existing caller file");
        expect(existsSync(join(output, "worker", "main.js"))).toBe(false);
      } else {
        expect(readdirSync(join(output, "worker", "main.js"))).toEqual([]);
      }
    },
  );

  it.each(["existing", "absent"])(
    "rejects a symlink parent of an %s output directory without touching its target",
    (childState) => {
      const parent = tempDirectory();
      const external = tempDirectory();
      const marker = new Uint8Array([255, 0, 128, 1]);
      const target = join(external, "sentinel");
      writeFileSync(target, marker);
      const linkedParent = join(parent, "linked-parent");
      symlinkSync(external, linkedParent);
      const child = join(external, "out");
      if (childState === "existing") mkdirSync(child);
      const output = join(linkedParent, "out");
      const existingEntries = readdirSync(external).sort();
      expect(() => writeDeployBundleWithAssets(copyBundle(), output)).toThrow(/output symlink/);
      expect(readFileSync(target).equals(Buffer.from(marker))).toBe(true);
      expect(readdirSync(external).sort()).toEqual(existingEntries);
      expect(existsSync(child)).toBe(childState === "existing");
      if (childState === "existing") expect(readdirSync(child)).toEqual([]);
      expect(existsSync(join(output, "worker", "main.js"))).toBe(false);
      for (const manifest of ["bundle.json", "bundle.mixed.json", "bundle.resources.json"]) {
        expect(existsSync(join(output, manifest))).toBe(false);
      }
    },
  );
});
