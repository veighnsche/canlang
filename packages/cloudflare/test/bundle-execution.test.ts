import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({ environments: [] as NodeJS.ProcessEnv[], directories: [] as string[] }));
vi.mock("../src/deploy/producer-files.js", () => ({ resolveProducerFile: () => "/private/tmp/producer.js" }));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  execFileSync: (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    observed.environments.push(options.env);
    observed.directories.push(dirname(args[3]!));
    expect(readFileSync(args[3]!, "utf8")).toContain("createMcpHandler");
    writeFileSync(args[4]!, "createMcpHandler createArtifactRegistry createArtifactCatalog IdentityError");
  },
}));
import { buildMcpBundle } from "../src/deploy/bundle.js";

it("pins each esbuild subprocess environment and scratch root without changing the host", async () => {
  const root = await mkdtemp(join(tmpdir(), "can-bundle-execution-"));
  const original = process.env.ESBUILD_BINARY_PATH;
  try {
    for (const binary of ["/a/esbuild", "/b/esbuild"]) {
      expect(buildMcpBundle(undefined, undefined, { esbuildBinaryPath: binary, temporaryRoot: root })).toContain("createMcpHandler");
      expect(process.env.ESBUILD_BINARY_PATH).toBe(original);
    }
    expect(observed.environments.map(env => env.ESBUILD_BINARY_PATH)).toEqual(["/a/esbuild", "/b/esbuild"]);
    expect(observed.directories.every(path => dirname(path) === root && !existsSync(path))).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
