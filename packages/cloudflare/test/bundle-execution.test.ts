import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

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
import { buildMcpBundle, hashProducerInputs, producerBundleKey, producerToolId } from "../src/deploy/bundle.js";

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

describe("producer bundle exact-key reuse identity", () => {
  const keyFor = (entry: string, files: string[], binary?: string): string | null => {
    const digest = hashProducerInputs(files);
    const tool = producerToolId(binary === undefined ? {} : { esbuildBinaryPath: binary });
    if (digest === null || tool === null) return null;
    return producerBundleKey("mcp", entry, digest, tool, false);
  };

  it("keys identical inputs deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "can-bundle-key-"));
    try {
      const first = join(root, "a.js"), second = join(root, "b.js");
      writeFileSync(first, "export const a = 1;\n", "utf8");
      writeFileSync(second, "export const b = 2;\n", "utf8");
      expect(keyFor("entry", [first, second])).toBe(keyFor("entry", [second, first]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("misses on changed dependency bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "can-bundle-key-"));
    try {
      const file = join(root, "dep.js");
      writeFileSync(file, "export const a = 1;\n", "utf8");
      const before = keyFor("entry", [file]);
      writeFileSync(file, "export const a = 2;\n", "utf8");
      expect(keyFor("entry", [file])).not.toBe(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses missing inputs instead of keying them", async () => {
    const root = await mkdtemp(join(tmpdir(), "can-bundle-key-"));
    try {
      expect(hashProducerInputs([join(root, "absent.js")])).toBeNull();
      expect(keyFor("entry", [join(root, "absent.js")])).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("misses on changed tool selection and entry source", async () => {
    const root = await mkdtemp(join(tmpdir(), "can-bundle-key-"));
    try {
      const file = join(root, "dep.js");
      writeFileSync(file, "export const a = 1;\n", "utf8");
      const baseline = keyFor("entry", [file]);
      expect(keyFor("entry", [file], "/a/esbuild")).not.toBe(baseline);
      expect(keyFor("entry", [file], "/a/esbuild")).toBe(keyFor("entry", [file], "/a/esbuild"));
      expect(keyFor("other-entry", [file])).not.toBe(baseline);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
