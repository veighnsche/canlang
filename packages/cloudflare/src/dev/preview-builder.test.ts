import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CompileArtifact } from "@canlang/contracts";
import { createLocalPreviewBuilder, PreviewAdmissionError, selectPreviewWorkerVars } from "./preview-builder.js";
import { captureSingleFileSource } from "./source-capture.js";

test("preview admission refuses missing D1, Identity and portable input evidence before opening a build", async () => {
  const root = await mkdtemp(join(tmpdir(), "can-preview-admission-"));
  try {
    await writeFile(join(root, "Office.can"), "# Track supplies.\napp Office\nGiven\n  Supply in team { name:text! }\nWhen\n  crud Supply by=members fields=name\nThen\n  page / title=\"Supplies\"\n    list Supply\n");
    for (const file of ["can", "catalog.json", "help.md", "worker.js"]) await writeFile(join(root, file), file);
    const capture = await captureSingleFileSource({
      checkoutRoot: root, appPath: "Office.can", profile: "local-d1-identity",
      compilerPath: "can", catalogPath: "catalog.json", helpIndexPath: "help.md",
      packageInputPaths: [{ name: "worker", path: "worker.js" }],
    });
    const artifact = {
      sources: [{ path: capture.compilerOperand, sha256: capture.sourceSha256 }],
      pages: [{ owner: "Office", path: "/", module: "main.js", export: "page" }],
      operations: [{ id: "Office.Supply.create" }],
      callables: [], requires: [{ capability: "state", min_version: 1 }],
    } as unknown as CompileArtifact;
    let producerCalls = 0;
    const producer = async () => {
      producerCalls += 1;
      return {
        captureEpochMaterial: capture.epochMaterial,
        artifactJsonSha256: createHash("sha256").update(JSON.stringify(artifact)).digest("hex"),
        consumedInputs: [],
        bundle: {} as never,
      };
    };
    const expectCode = async (resources: Parameters<typeof createLocalPreviewBuilder>[0]["resources"], code: string) => {
      await assert.rejects(createLocalPreviewBuilder({ resources, activationVerdict: async () => ({ active: true }),
        produceBundle: producer })(artifact, capture), error =>
        error instanceof PreviewAdmissionError && error.code === code);
    };
    await expectCode({ identity: { backingBinding: "DB", availability: "real_local" } }, "D1_UNAVAILABLE");
    await expectCode({ d1: { binding: "DB", availability: "real_local" } }, "IDENTITY_UNAVAILABLE");
    assert.equal(producerCalls, 0);
    const resources = {
      d1: { binding: "DB", availability: "real_local" as const },
      identity: { backingBinding: "DB", availability: "real_local" as const },
    };
    await assert.rejects(createLocalPreviewBuilder({ resources })(artifact, capture), error =>
      error instanceof PreviewAdmissionError && error.code === "ACTIVATION_UNAVAILABLE");
    await assert.rejects(createLocalPreviewBuilder({ resources,
      activationVerdict: async () => ({ active: false, reasons: [] }) })(artifact, capture), error =>
      error instanceof PreviewAdmissionError && error.code === "ACTIVATION_REFUSED");
    await assert.rejects(createLocalPreviewBuilder({ resources,
      activationVerdict: async () => ({ active: true }) })(artifact, capture), error =>
      error instanceof PreviewAdmissionError && error.code === "PORTABLE_BUNDLE_UNAVAILABLE");
    await expectCode(resources, "BUNDLE_INPUTS_INCOMPLETE");
    assert.equal(producerCalls, 1);
    await assert.rejects(createLocalPreviewBuilder({
      resources,
      activationVerdict: async () => ({ active: true }),
      produceBundle: async () => ({
        captureEpochMaterial: capture.epochMaterial,
        artifactJsonSha256: createHash("sha256").update(JSON.stringify(artifact)).digest("hex"),
        consumedInputs: capture.inputs.filter(input => input.name.startsWith("package:")),
        bundle: { modules: {}, binaries: {} } as never,
      }),
    })(artifact, capture), error => error instanceof PreviewAdmissionError && error.code === "BUNDLE_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preview auth origin comes from the selected protected loopback port", () => {
  const origin = "http://127.0.0.1:43217";
  assert.deepEqual(selectPreviewWorkerVars({ resources: {} }, origin), { CAN_AUTH_ORIGIN: origin });
  assert.deepEqual(selectPreviewWorkerVars({ resources: {}, workerVarsForOrigin: () => ({ CAN_AUTH_COOKIE_SECURE: false }) }, origin),
    { CAN_AUTH_COOKIE_SECURE: false, CAN_AUTH_ORIGIN: origin });
  assert.throws(() => selectPreviewWorkerVars({
    resources: {}, workerVarsForOrigin: () => ({ CAN_AUTH_ORIGIN: "http://127.0.0.1:1" }),
  }, origin), error => error instanceof PreviewAdmissionError && error.code === "RESOURCE_INVALID");
  assert.throws(() => selectPreviewWorkerVars({ resources: {} }, "http://example.com"), error =>
    error instanceof PreviewAdmissionError && error.code === "ORIGIN_INVALID");
});
