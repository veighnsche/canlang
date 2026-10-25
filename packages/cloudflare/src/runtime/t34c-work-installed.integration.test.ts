/**
 * T34c work installed proof: the staged recovery.wasm binary executes
 * genuine family calculations inside workerd.
 *
 * The installed C04 asset gather supplies the exact staged bytes;
 * startLocalDev stages them as CompiledWasm; a probe entry
 * instantiates the import-free module and runs one closed-data op per
 * rows/receipt/recovery through the real selected-call facade. The
 * same inputs run through the local ts backend (and the local wasm
 * backend) in this process: workerd-wasm must agree with both.
 *
 * Run from dist FROM THE REPO ROOT: root build, then
 * `node --test packages/cloudflare/dist/runtime/t34c-work-installed.integration.test.js`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkKernel } from "@canlang/work-kernel";
import { distribution as workKernelDistribution } from "@canlang/work-kernel/distribution";
import { gatherDeploymentAssets } from "../deploy/package-assets.js";
import { startLocalDev } from "./native-preview.test-support.js";
import { PINNED_COMPATIBILITY_DATE } from "../cli/artifact-defaults.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK_KERNEL_DIST = fileURLToPath(workKernelDistribution.modules);
const FIXTURES = join(HERE, "..", "..", "..", "work-kernel", "conformance", "fixtures");
const WASM_KEY = "vendor/work-kernel/native/recovery.wasm";

type Probe = { readonly id: string; readonly leaf: "rows" | "receipt" | "recovery"; readonly fn: string; readonly input: readonly unknown[] };

function loadProbe(file: string, id: string, leaf: Probe["leaf"]): Probe {
  const cases = JSON.parse(readFileSync(join(FIXTURES, file), "utf8")).cases as Array<{
    id: string; fn: string; input: unknown[];
  }>;
  const found = cases.find((entry) => entry.id === id);
  assert.ok(found, `probe case ${id} exists`);
  return { id, leaf, fn: found.fn, input: found.input };
}

/** Mirror the deploy readVendorTree walk for the kernel dist closure. */
function kernelModules(): Record<string, string> {
  const modules: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, `${prefix}/${entry}`);
        continue;
      }
      if (!entry.endsWith(".js") || entry.endsWith(".test.js") || entry === "distribution.js") continue;
      modules[`${prefix}/${entry}`] = readFileSync(full, "utf8");
    }
  };
  for (const sub of ["src", "bindings"]) walk(join(WORK_KERNEL_DIST, sub), `wk/${sub}`);
  assert.ok(Object.keys(modules).length > 10, "kernel dist closure is non-trivial");
  return modules;
}

function entrySource(probes: readonly Probe[]): string {
  return `import { createWorkKernel } from './wk/bindings/work-kernel.js';
import wasmModule from './${WASM_KEY}';
const kernel = createWorkKernel({ backend: 'wasm', module: wasmModule });
const probes = ${JSON.stringify(probes)};
export default {
  async fetch() {
    const results = probes.map(({ leaf, fn, input }) => {
      try {
        return { ok: true, value: kernel[leaf][fn](...input) };
      } catch (error) {
        return { ok: false, name: error?.name, message: String(error?.message ?? error) };
      }
    });
    return Response.json({ imports: WebAssembly.Module.imports(wasmModule).length, results });
  },
};
`;
}

describe("T34c work installed binary executes families in workerd", () => {
  it("stages the exact C04 recovery bytes and agrees across backends", async () => {
    const assets = gatherDeploymentAssets({ workKernelRecovery: true });
    const staged = assets.binaries[WASM_KEY];
    assert.ok(staged instanceof Uint8Array, "installed gather carries the recovery binary");
    const manifest = JSON.parse(
      readFileSync(join(WORK_KERNEL_DIST, "native", "BUILD.json"), "utf8"),
    ) as { files: Record<string, { bytes: number; sha256: string }> };
    const pinned = manifest.files["recovery.wasm"];
    assert.ok(pinned, "BUILD.json pins recovery.wasm");
    assert.equal(staged.length, pinned.bytes);
    assert.equal(createHash("sha256").update(staged).digest("hex"), pinned.sha256);

    const probes = [
      loadProbe("rows/dispatch.json", "new-ok", "rows"),
      loadProbe("receipts/receipt.json", "dead-letter-sorted", "receipt"),
      loadProbe("receipts/recovery.json", "release-stale", "recovery"),
    ];
    // Local ts agreement first (also proves the probes JSON-serialize).
    const ts = createWorkKernel({ backend: "ts" });
    const expected = probes.map(({ leaf, fn, input }) => {
      const families = ts as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>;
      const family = families[leaf];
      assert.ok(family, `ts family ${leaf} exists`);
      const method = family[fn];
      assert.ok(typeof method === "function", `ts method ${leaf}.${fn} exists`);
      return { ok: true, value: method(...(input as unknown[])) };
    });
    assert.equal(JSON.parse(JSON.stringify(expected)).length, 3);

    const worker = await startLocalDev({
      workerName: `work-installed-${randomUUID()}`,
      compatibilityDate: PINNED_COMPATIBILITY_DATE,
      mainModule: "wk-entry.js",
      modules: { ...kernelModules(), "wk-entry.js": entrySource(probes) },
      binaryModules: { [WASM_KEY]: staged },
    });
    try {
      const response = await worker.dispatch("/");
      assert.equal(response.status, 200);
      const body = (await response.json()) as { imports: number; results: unknown[] };
      assert.equal(body.imports, 0, "recovery module stays import-free in workerd");
      assert.equal(body.results.length, 3);
      assert.deepEqual(body.results, JSON.parse(JSON.stringify(expected)));
    } finally {
      await worker.dispose();
    }
  });
});
