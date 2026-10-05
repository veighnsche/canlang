import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PINNED_COMPATIBILITY_DATE,
  assertDistReady,
  discoverArtifact,
  resolveLocalDefaults,
} from "../src/dev/zero-config.js";
import { UI_BUILD_COMMAND, UI_DIST_ENTRY_RELATIVE } from "../src/runtime/modules.js";

const SHA = "a".repeat(64);

function validArtifact(): Record<string, unknown> {
  return {
    artifact_version: 1,
    language_version: "1.0.0",
    tool_version: "0.1.0",
    sources: [{ path: "app.can", sha256: SHA }],
    modules: [
      {
        path: "worker.mjs",
        js: "export default { async fetch() { return new Response(\"ok\"); } };\n",
        map: { version: 3, file: "worker.mjs", sources: [], sourcesContent: [], names: [], mappings: "" },
      },
    ],
    callables: [],
    pages: [],
    requires: [],
    tests: [],
  };
}

function cwdWithArtifacts(names: string[]): string {
  const cwd = mkdtempSync(join(tmpdir(), "can-zero-"));
  const dist = join(cwd, "dist");
  mkdirSync(dist, { recursive: true });
  for (const name of names) {
    writeFileSync(join(dist, name), JSON.stringify(validArtifact()));
  }
  return cwd;
}

describe("zero-config local defaults (B5-J3)", () => {
  it("pins a compatibility date", () => {
    expect(PINNED_COMPATIBILITY_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("empty dir: discovery fails loud naming the pattern", () => {
    const cwd = mkdtempSync(join(tmpdir(), "can-zero-empty-"));
    expect(() => discoverArtifact(cwd)).toThrow(/\.\/dist\/\*\.artifact\.json/);
    expect(() => resolveLocalDefaults({ cwd })).toThrow(/\.\/dist\/\*\.artifact\.json/);
  });

  it("multiple candidates: discovery fails loud listing them + --artifact", () => {
    const cwd = cwdWithArtifacts(["a.artifact.json", "b.artifact.json"]);
    let message = "";
    try {
      discoverArtifact(cwd);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("a.artifact.json");
    expect(message).toContain("b.artifact.json");
    expect(message).toContain("--artifact");
  });

  it("single candidate: defaults resolve (workerName from artifact, pinned date)", () => {
    const cwd = cwdWithArtifacts(["teamtasks.artifact.json"]);
    const defaults = resolveLocalDefaults({ cwd });
    expect(defaults.artifactPath).toBe(join(cwd, "dist", "teamtasks.artifact.json"));
    expect(defaults.workerName).toBe("teamtasks");
    expect(defaults.compatibilityDate).toBe(PINNED_COMPATIBILITY_DATE);
  });

  it("explicit --artifact wins over discovery", () => {
    const cwd = cwdWithArtifacts(["teamtasks.artifact.json"]);
    const other = join(cwd, "other.artifact.json");
    writeFileSync(other, JSON.stringify(validArtifact()));
    const defaults = resolveLocalDefaults({ cwd, artifactPath: other });
    expect(defaults.artifactPath).toBe(other);
    expect(defaults.workerName).toBe("other");
  });

  it("workerName sanitizes the artifact stem", () => {
    const cwd = cwdWithArtifacts(["Team_Tasks v2.artifact.json"]);
    const defaults = resolveLocalDefaults({ cwd });
    expect(defaults.workerName).toMatch(/^[a-z0-9-]+$/);
  });

  it("missing dist: loud error naming the build command", async () => {
    const distRoot = mkdtempSync(join(tmpdir(), "can-zero-dist-"));
    await expect(assertDistReady(distRoot)).rejects.toThrow(UI_BUILD_COMMAND);
  });

  it("present dist entry: check passes", async () => {
    const distRoot = mkdtempSync(join(tmpdir(), "can-zero-dist-"));
    const entry = join(distRoot, UI_DIST_ENTRY_RELATIVE);
    mkdirSync(join(entry, ".."), { recursive: true });
    writeFileSync(entry, "export {};\n");
    await expect(assertDistReady(distRoot)).resolves.toBeUndefined();
  });
});
