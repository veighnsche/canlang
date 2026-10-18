import assert from "node:assert/strict";
import test from "node:test";
import type { CompileArtifact } from "@canlang/contracts";
import { buildOwnedDeployBundleWithAssets } from "./owned-bundle.js";
import { startLocalDev } from "../dev/local-run.js";
import { bundlerExecutableInputs } from "../dev/preview-inputs.js";
import { PINNED_COMPATIBILITY_DATE } from "../cli/artifact-defaults.js";

test("owned portable build returns a genuine browser bundle loadable by workerd", { timeout: 120_000 }, async () => {
  const artifact: CompileArtifact = {
    artifact_version: 1, language_version: "1.0.0", tool_version: "0.1.0",
    sources: [{ path: "app.can", sha256: "0".repeat(64) }],
    modules: [{ path: "app.js", js: 'export const appDefinition = { id: "test" };',
      map: { version: 3, file: "app.can", sources: [], sourcesContent: [], names: [], mappings: "" } }],
    callables: [], operations: [], pages: [], requires: [], tests: [],
  };
  const binary = bundlerExecutableInputs().find(input => input.name === "esbuild")!;
  const original = process.env.ESBUILD_BINARY_PATH;
  const bundle = await buildOwnedDeployBundleWithAssets(artifact, {
    verdict: { active: true }, assets: { browser: true }, esbuildBinaryPath: binary.path,
  });
  assert.equal(process.env.ESBUILD_BINARY_PATH, original);
  assert.ok(bundle.mcpBundleBytes > 100_000);
  assert.ok(bundle.httpOperationsBytes > 10_000);
  assert.ok(bundle.resources["browser/bootstrap.js"]!.bytes instanceof Uint8Array);
  const dev = await startLocalDev({
    workerName: "owned-bundle", compatibilityDate: PINNED_COMPATIBILITY_DATE,
    mainModule: bundle.mainModule, modules: bundle.modules,
  });
  try {
    const response = await dev.dispatch("/");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { code: "missing-binding", binding: "DB" });
  } finally { await dev.dispose(); }
});
