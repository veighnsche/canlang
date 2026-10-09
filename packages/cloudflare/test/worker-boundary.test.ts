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

const JOIN_RUNTIME_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  // Both leaves are explicitly pinned by deploy/bundle.ts and accept only
  // injected D1/clock ports. Their own source remains checked below.
  "src/runtime/env-assembly.ts": ["./auth-rate-limiter.js", "./page-preferences.js"],
};

function importSpecifier(line: string): string | undefined {
  return /\bfrom\s+["']([^"']+)["'];?$/u.exec(line)?.[1];
}

function isPortableAssemblyImport(file: string, line: string): boolean {
  if (file !== "src/dev/example-runner.ts" || importSpecifier(line) !== "../worker/assembly.js") return false;
  const bindings = /^import\s+\{([^}]+)\}\s+from\s/u.exec(line)?.[1];
  if (bindings === undefined) return false;
  // Published portable invocation/storage constructors; the serving worker
  // entry and main, wildcard imports and other assembly exports stay barred.
  const allowed = new Set(["buildInvoker", "createTeamOwnerStorageBoundary", "type TeamOwnerStorageBoundary"]);
  return bindings.split(",").every(binding => allowed.has(binding.trim().split(/\s+as\s+/u)[0]!));
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

  it("keeps staged producer joins dynamic and their exact local D1 leaves worker-safe", () => {
    // env-assembly, grant-route, and mcp-permissions load producers via
    // dynamic import() so the P-B bundler can stage/rewrite them; a static
    // external runtime import here would bypass the vendor seam. Only the
    // two explicitly pinned local D1 leaves are admitted statically; all
    // their imports remain type-only. The final installed graph is checked
    // by assertLinksResolve and assertWorkerdLoadable at bundle construction.
    const joinFiles = [
      "src/runtime/env-assembly.ts",
      "src/runtime/grant-route.ts",
      "src/runtime/mcp-permissions.ts",
      "src/runtime/auth-rate-limiter.ts",
      "src/runtime/page-preferences.ts",
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
        if (trimmed.startsWith("import ") && !trimmed.startsWith("import type ")) {
          expect(
            (JOIN_RUNTIME_IMPORTS[file] ?? []).includes(importSpecifier(trimmed) ?? ""),
            `${location} must use 'import type' or an exact pinned D1 leaf (producers load dynamically): ${trimmed}`,
          ).toBe(true);
        }
        expect(
          trimmed.startsWith("export ") && trimmed.includes(" from "),
          `${location} must not re-export from another module: ${trimmed}`,
        ).toBe(false);
        expect(trimmed.includes("require("), `${location} must not use require()`).toBe(false);
        expect(trimmed.includes("node:"), `${location} must not touch node: builtins`).toBe(false);
      }
      expect(seen, `${file} is missing from the tree (silent skip)`).toBe(true);
    }
  });

  it("keeps Node hosts out of Worker serving entries while retaining the portable assembly contract", () => {
    const manifest = JSON.parse(readSource("package.json")) as {
      exports: Record<string, { default?: string }>;
    };
    expect(manifest.exports["./worker/assembly"]?.default).toBe("./dist/worker/assembly.js");
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
            (trimmed.includes("./worker/") || trimmed.includes("../worker/")) && !isPortableAssemblyImport(file, trimmed),
            `${location} must not import Worker serving sources (only published portable constructors are shared): ${trimmed}`,
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
