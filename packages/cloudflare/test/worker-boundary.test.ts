import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageRoot = new URL("..", import.meta.url);

function listSourceFiles(relativeDir: string): string[] {
  const url = new URL(`${relativeDir}/`, packageRoot);
  return readdirSync(url)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `${relativeDir}/${name}`);
}

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, packageRoot), "utf8");
}

describe("worker bundle boundary", () => {
  it("allows no runtime imports in src/worker (type-only imports only)", () => {
    const workerFiles = listSourceFiles("src/worker");
    expect(workerFiles.length).toBeGreaterThan(0);
    for (const file of workerFiles) {
      const lines = readSource(file).split("\n");
      for (const [index, line] of lines.entries()) {
        const trimmed = line.trim();
        expect(
          trimmed.startsWith("import ") && !trimmed.startsWith("import type "),
          `${file}:${index + 1} must use 'import type' (no runtime imports in Worker code): ${trimmed}`,
        ).toBe(false);
        expect(trimmed.includes("require("), `${file}:${index + 1} must not use require()`).toBe(false);
        expect(trimmed.includes("node:"), `${file}:${index + 1} must not touch node: builtins`).toBe(false);
      }
    }
  });

  it("keeps the Node entry free of worker imports", () => {
    for (const file of ["src/index.ts", ...listSourceFiles("src/deploy"), ...listSourceFiles("src/dev")]) {
      const source = readSource(file);
      expect(source.includes("./worker/") || source.includes("../worker/")).toBe(false);
    }
  });
});
