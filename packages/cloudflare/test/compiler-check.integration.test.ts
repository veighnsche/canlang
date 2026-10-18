import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { distribution as valuesDistribution } from "@canlang/values/distribution";
import { captureSingleFileSource, type SingleFileCaptureRequest } from "../src/runtime/native-dev.test-support.js";
import { admitSingleAppProfile, compileCapturedSingleFile } from "../src/runtime/native-dev.test-support.js";

const repo = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const witness = join(repo, "tests/integration/can-dev-server/OfficeSupplies.can");
const realCompiler = join(repo, "compiler/target/debug/can");
const catalog = fileURLToPath(valuesDistribution.catalog);
const helpIndex = join(repo, "docs/specification/CONSTRUCT-HELP.md");
const packageOutput = join(repo, "packages/cloudflare/dist/runtime/artifact.js");

async function tempWitness(): Promise<{ root: string; app: string; request: SingleFileCaptureRequest }> {
  const root = mkdtempSync(join(tmpdir(), "can-dev-compiler-check-"));
  const app = join(root, "OfficeSupplies.can");
  writeFileSync(app, await readFile(witness));
  return {
    root,
    app,
    request: {
      checkoutRoot: root,
      appPath: "OfficeSupplies.can",
      profile: "office-supplies-v1",
      compilerPath: realCompiler,
      catalogPath: catalog,
      helpIndexPath: helpIndex,
      packageInputPaths: [{ name: "cloudflare-artifact", path: packageOutput }],
    },
  };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for compiler gate: ${path}`);
}

describe("captured compiler against the Office Supplies evaluator source", () => {
  it("selects the owning native receipt CLI contract for the captured State host", async () => {
    const { root, app, request } = await tempWitness();
    try {
      writeFileSync(app, 'app CallerReceipts\nGiven\nWhen\n scenario saved() -> int by=members\n  do return 7\nThen\n');
      const capture = await captureSingleFileSource(request);
      const result = await compileCapturedSingleFile(capture, new AbortController().signal);
      if (result.kind !== 'artifact') throw new Error(`native captured receipt compile refused: ${result.kind}`);
      expect(result.artifact.sources).toEqual([{ path: capture.compilerOperand, sha256: capture.sourceSha256 }]);
      const operation = result.artifact.operations?.find(entry => entry.name === 'CallerReceipts.saved');
      expect(operation?.result?.disclosure?.version).toBe(1);
      expect(operation?.result?.disclosure?.source).toMatchObject({ path: capture.compilerOperand, sha256: capture.sourceSha256 });
      expect(operation?.result?.disclosure?.returns).toHaveLength(1);
      expect(result.artifact.modules.some(module => module.js.includes('selectScenarioReceiptReturn'))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30000);

  it("returns only current, exact-source diagnostics or an artifact", async () => {
    const { root, request } = await tempWitness();
    try {
      const capture = await captureSingleFileSource(request);
      const result = await compileCapturedSingleFile(capture);
      expect(result.capture.sourceRevision).toBe(capture.sourceRevision);
      if (result.kind === "diagnostics") {
        expect(result.envelope.complete).toBe(true);
        expect(result.envelope.sources).toEqual([{ id: 0, path: "OfficeSupplies.can", sha256: capture.sourceSha256 }]);
        expect(result.envelope.diagnostics.length).toBeGreaterThan(0);
        expect(result.envelope.diagnostics.every((entry) =>
          typeof entry === "object" && entry !== null && "code" in entry && entry.code === "E6008",
        )).toBe(true);
      } else if (result.kind === "artifact") {
        expect(result.artifact.sources).toEqual([{ path: "OfficeSupplies.can", sha256: capture.sourceSha256 }]);
        expect(result.artifact.pages.length).toBeGreaterThan(0);
      } else {
        throw new Error(`captured compiler did not return a checked witness: ${result.kind}: ${result.reason}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("admits one same-file composition while the compiler owns its package references", async () => {
    const { root, app, request } = await tempWitness();
    const source = 'app OfficeSupplies uses=[Catalog]\n\npackage Catalog\n Given\n  Supply {name:text}\n  policy Supply read=members\n When\n  crud Supply by=members fields=name\n Then\n  page / title="Supplies"\n   list Supply\n    text row.name\n';
    try {
      writeFileSync(app, source);
      const capture = await captureSingleFileSource(request);
      const result = await compileCapturedSingleFile(capture);
      expect(result.kind).toBe("artifact");
      if (result.kind === "artifact") {
        expect(result.artifact.sources).toEqual([{ path: capture.compilerOperand, sha256: capture.sourceSha256 }]);
        expect(result.artifact.pages).toHaveLength(1);
        expect(result.artifact.pages[0]?.owner).toBe("Catalog");
      }
      writeFileSync(app, source.replace("uses=[Catalog]", "uses=[Missing]"));
      const missing = await compileCapturedSingleFile(await captureSingleFileSource(request));
      expect(missing.kind).toBe("diagnostics");
      if (missing.kind === "diagnostics") {
        expect(missing.envelope.complete).toBe(true);
        expect(missing.envelope.diagnostics.some(diagnostic =>
          typeof diagnostic === "object" && diagnostic !== null && "code" in diagnostic && diagnostic.code === "E2005" &&
          "message" in diagnostic && diagnostic.message === "app 'OfficeSupplies' selects unknown member 'Missing'")).toBe(true);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30000);

  it("refuses imports and multiple apps before a whole-app result", async () => {
    const { root, app, request } = await tempWitness();
    try {
      const source = await readFile(app, "utf8");
      writeFileSync(app, source.replace("When\n", "When\n use Extra {Thing}\n"));
      const importResult = await compileCapturedSingleFile(await captureSingleFileSource(request));
      expect(importResult.kind).toBe("profile_unsupported");
      if (importResult.kind === "profile_unsupported") expect(importResult.reason).toMatch(/imported members/);

      writeFileSync(app, source + "\napp Another\nGiven\nWhen\nThen\n");
      const multiple = await compileCapturedSingleFile(await captureSingleFileSource(request));
      expect(multiple.kind).toBe("profile_unsupported");
      if (multiple.kind === "profile_unsupported") expect(multiple.reason).toMatch(/exactly one app/);
      expect(admitSingleAppProfile("package Orphan\n Given\n When\n Then\n").ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a catalog changed after capture before invoking the compiler", async () => {
    const { root, request } = await tempWitness();
    try {
      const localCatalog = join(root, "catalog.json");
      writeFileSync(localCatalog, await readFile(catalog));
      const capture = await captureSingleFileSource({ ...request, catalogPath: localCatalog });
      writeFileSync(localCatalog, "{\"changed\":true}");
      const result = await compileCapturedSingleFile(capture);
      expect(result.kind).toBe("capture_incomplete");
      if (result.kind === "capture_incomplete") expect(result.reason).toMatch(/input catalog changed after capture/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("withholds a compiler result when the captured source changes while it runs", async () => {
    const { root, app, request } = await tempWitness();
    const ready = join(root, "compiler-ready");
    const release = join(root, "compiler-release");
    const gatedCompiler = join(root, "gated-compiler");
    writeFileSync(gatedCompiler, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
fs.writeFileSync(${JSON.stringify(ready)}, "ready");
function runWhenReleased() {
  if (!fs.existsSync(${JSON.stringify(release)})) return setTimeout(runWhenReleased, 10);
  const child = spawnSync(${JSON.stringify(realCompiler)}, process.argv.slice(2), { stdio: "inherit" });
  process.exit(child.status ?? 2);
}
runWhenReleased();
`);
    try {
      const capture = await captureSingleFileSource({ ...request, compilerPath: gatedCompiler });
      const pending = compileCapturedSingleFile(capture);
      await waitForFile(ready);
      writeFileSync(app, `${await readFile(app, "utf8")}\n## edited during compile\n`);
      writeFileSync(release, "go");
      const result = await pending;
      expect(result.kind).toBe("capture_incomplete");
      if (result.kind === "capture_incomplete") expect(result.reason).toMatch(/inputs changed during compiler execution/);
    } finally {
      writeFileSync(release, "go");
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
