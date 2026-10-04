import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageRoot = new URL("..", import.meta.url);

function listSourceFiles(relativeDir: string): string[] {
  const url = new URL(`${relativeDir}/`, packageRoot);
  if (!existsSync(url)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of readdirSync(url, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...listSourceFiles(`${relativeDir}/${entry.name}`));
    } else if (entry.name.endsWith(".ts")) {
      found.push(`${relativeDir}/${entry.name}`);
    }
  }
  return found;
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
        const location = `${file}:${index + 1}`;
        expect(
          trimmed.startsWith("import ") && !trimmed.startsWith("import type "),
          `${location} must use 'import type' (no runtime imports in Worker code): ${trimmed}`,
        ).toBe(false);
        expect(
          trimmed.startsWith("export ") && trimmed.includes(" from "),
          `${location} must not re-export from another module: ${trimmed}`,
        ).toBe(false);
        expect(trimmed.includes("require("), `${location} must not use require()`).toBe(false);
        expect(trimmed.includes("node:"), `${location} must not touch node: builtins`).toBe(false);
      }
    }
  });

  it("keeps the Node entry free of worker imports", () => {
    const nodeFiles = [
      "src/index.ts",
      ...listSourceFiles("src/deploy"),
      ...listSourceFiles("src/dev"),
      ...listSourceFiles("src/build"),
      ...listSourceFiles("src/upgrade"),
      ...listSourceFiles("src/cli"),
    ];
    for (const file of nodeFiles) {
      const lines = readSource(file).split("\n");
      for (const [index, line] of lines.entries()) {
        const trimmed = line.trim();
        const location = `${file}:${index + 1}`;
        if (trimmed.startsWith("import ") || trimmed.includes(" from ")) {
          expect(
            trimmed.includes("./worker/") || trimmed.includes("../worker/"),
            `${location} must not import worker sources: ${trimmed}`,
          ).toBe(false);
          expect(
            trimmed.includes("@canlang/cloudflare/worker"),
            `${location} must not self-import the worker export: ${trimmed}`,
          ).toBe(false);
        }
      }
    }
  });
});
