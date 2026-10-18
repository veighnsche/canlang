import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { CompileArtifact } from "@canlang/contracts";
import type { SingleFileCapture } from "../src/dev/source-capture.js";

const mocks = vi.hoisted(() => ({ start: vi.fn(), dispose: vi.fn() }));
vi.mock("../src/dev/local-run.js", () => ({ startLocalDev: mocks.start }));
vi.mock("../src/dev/source-capture.js", () => ({ captureIsCurrent: async () => true }));
vi.mock("../src/dev/local-bindings.js", () => ({ configureLocalBindings: () => ({ worker: {} }), planLocalBindings: () => ({}) }));
vi.mock("../src/dev/preview-inputs.js", () => ({
  installedPortableBundleInputs: () => [], installedOwnedSourceInputs: () => [],
  bundlerExecutableInputs: () => [], compilerSourceInputs: () => [],
  installedReferenceRoot: (root: string) => root, assertInstalledCatalog: () => {},
}));
import { preflightLocalPreviewActivation } from "../src/dev/preview-host.js";
import { DevCleanupError } from "../src/dev/cleanup.js";

it("retains preflight runtime after failed cleanup, then releases on retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "can-preflight-test-"));
  const grammar = join(root, "docs/specification/GRAMMAR.md");
  await mkdir(join(root, "docs/specification"), { recursive: true });
  await writeFile(grammar, "grammar");
  const capture = { root, inputs: [
    { name: "compiler", requestedPath: process.execPath },
    { name: "catalog", requestedPath: join(root, "catalog.json") },
    { name: "extra:grammar", canonicalPath: realpathSync(grammar), state: "present" },
  ] } as unknown as SingleFileCapture;
  mocks.dispose.mockRejectedValue(new Error("preflight still alive"));
  mocks.start.mockResolvedValue({ dispose: mocks.dispose, getD1Database: async () => { throw new Error("D1 probe failed"); } });
  let failure: DevCleanupError | undefined;
  try {
    failure = await preflightLocalPreviewActivation({} as CompileArtifact, capture).catch(error => error);
    expect(failure).toBeInstanceOf(DevCleanupError);
    expect(failure!.message).toContain("D1 probe failed");
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    mocks.dispose.mockResolvedValue(undefined);
    await failure!.dispose();
    expect(mocks.dispose).toHaveBeenCalledTimes(2);
  } finally {
    mocks.dispose.mockResolvedValue(undefined);
    if (failure instanceof DevCleanupError) await failure.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
