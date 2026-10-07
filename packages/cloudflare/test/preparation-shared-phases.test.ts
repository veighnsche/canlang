import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompileArtifact } from "@canlang/contracts";
import { buildDeployBundle, buildDerivedInputsModule } from "../src/deploy/bundle.js";
import { buildBundleWithHostPhases, runCatalogPhase, runMcpBunPhase } from "../src/preparation/build-adapter.js";

const controls = vi.hoisted(() => ({
  events: [] as string[],
  directories: [] as string[],
  missingProducer: false,
  drop: "",
}));

vi.mock("../src/deploy/producer-files.js", () => ({
  resolveProducerFile: (name: string) => {
    controls.events.push(name);
    if (controls.missingProducer) throw new Error("missing producer sentinel");
    return `/private/tmp/${name.replaceAll("/", "-")}.js`;
  },
}));

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFileSync: (_command: string, args: string[]) => {
    const phase = args[1]?.includes("mcp-bundle") ? "mcp" : "http";
    controls.events.push(phase);
    const output = args.find((arg) => arg.startsWith("--outfile="))?.slice(10);
    if (output === undefined) throw new Error("missing output argument");
    controls.directories.push(dirname(output));
    writeFileSync(output, controls.drop === phase ? "" : phase === "mcp"
      ? "createMcpHandler createArtifactRegistry createArtifactCatalog IdentityError"
      : "handleOperationRequest IdentityError");
  },
}));

describe("preparation shared defining phases", () => {
  afterEach(() => {
    for (const directory of controls.directories) expect(existsSync(directory)).toBe(false);
    controls.events = [];
    controls.directories = [];
    controls.missingProducer = false;
    controls.drop = "";
  });

  it("retains compatibility names as the defining functions", () => {
    expect(buildBundleWithHostPhases).toBe(buildDeployBundle);
    expect(runCatalogPhase).toBe(buildDerivedInputsModule);
  });

  it("preserves catalog getter exceptions without wrapping or a second derivation", () => {
    const sentinel = new Error("artifact operations getter");
    let reads = 0;
    const artifact = {
      artifact_version: 1,
      get operations() {
        reads += 1;
        throw sentinel;
      },
    } as unknown as CompileArtifact;
    let failure: unknown;
    try {
      runCatalogPhase(artifact);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBe(sentinel);
    expect(reads).toBe(1);
  });

  it("keeps MCP before HTTP and returns the same phase object fields", () => {
    expect(runMcpBunPhase()).toEqual({
      mcpHandlerJs: "createMcpHandler createArtifactRegistry createArtifactCatalog IdentityError",
      httpOperationsJs: "handleOperationRequest IdentityError",
    });
    expect(controls.events).toEqual([
      "@canlang/interfaces/mcp/server", "@canlang/cloudflare/runtime/mcp-registry", "mcp",
      "@canlang/interfaces/http/operations", "http",
    ]);
  });

  it("stops at a missing MCP producer before either Bun build", () => {
    controls.missingProducer = true;
    expect(() => runMcpBunPhase()).toThrow("missing producer sentinel");
    expect(controls.events).toEqual(["@canlang/interfaces/mcp/server"]);
  });

  it.each(["mcp", "http"])("refuses dropped %s markers and cleans temporary output", (phase) => {
    controls.drop = phase;
    expect(() => runMcpBunPhase()).toThrow(phase === "mcp"
      ? "MCP bundle build dropped createMcpHandler"
      : "HTTP bundle build dropped handleOperationRequest");
    expect(controls.events.filter((event) => event === "mcp" || event === "http"))
      .toEqual(phase === "mcp" ? ["mcp"] : ["mcp", "http"]);
  });
});
