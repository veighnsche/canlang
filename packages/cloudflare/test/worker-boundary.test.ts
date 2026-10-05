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

  it("keeps the staged join modules type-only (dynamic imports only)", () => {
    // env-assembly, grant-route, and mcp-permissions load producers via
    // dynamic import() so the P-B bundler can stage/rewrite them; a static
    // runtime import here would bypass the vendor seam. (The rest of
    // src/runtime legitimately uses static relative imports and is covered
    // by assertLinksResolve instead.)
    const joinFiles = [
      "src/runtime/env-assembly.ts",
      "src/runtime/grant-route.ts",
      "src/runtime/mcp-permissions.ts",
    ];
    for (const file of joinFiles) {
      const lines = readSource(file).split("\n");
      let seen = false;
      for (const [index, line] of lines.entries()) {
        const trimmed = line.trim();
        const location = `${file}:${index + 1}`;
        // Doc comments document the no-builtins rule; not code.
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
        if (trimmed.startsWith("import ")) seen = true;
        expect(
          trimmed.startsWith("import ") && !trimmed.startsWith("import type "),
          `${location} must use 'import type' (join modules load producers dynamically): ${trimmed}`,
        ).toBe(false);
        expect(
          trimmed.startsWith("export ") && trimmed.includes(" from "),
          `${location} must not re-export from another module: ${trimmed}`,
        ).toBe(false);
        expect(trimmed.includes("node:"), `${location} must not touch node: builtins`).toBe(false);
      }
      expect(seen, `${file} is missing from the tree (silent skip)`).toBe(true);
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
