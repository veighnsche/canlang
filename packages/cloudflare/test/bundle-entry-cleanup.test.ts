import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHttpOperationsBundle, buildMcpBundle } from "../src/deploy/bundle.js";

const control = vi.hoisted(() => ({
  directories: [] as string[], events: [] as string[],
  failure: "" as "" | "write" | "partial-write" | "scalar-write" | "cleanup" | "process" | "missing-bun" | "read",
  sentinel: new Error("entry write sentinel"),
}));
vi.mock("../src/deploy/producer-files.js", () => ({
  resolveProducerFile: (name: string) => `/private/tmp/${name.replaceAll("/", "-")}.js`,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    mkdtempSync: (prefix: string) => { const dir = fs.mkdtempSync(prefix); control.directories.push(dir); return dir; },
    writeFileSync: (file: string, contents: string, encoding: "utf8") => {
      control.events.push("write");
      if (control.failure === "write" || control.failure === "cleanup") throw control.sentinel;
      if (control.failure === "scalar-write") throw "write scalar";
      if (control.failure === "partial-write") {
        fs.writeFileSync(file, "partial", encoding);
        expect(fs.existsSync(file)).toBe(true);
        throw control.sentinel;
      }
      fs.writeFileSync(file, contents, encoding);
    },
    readFileSync: (file: string, encoding: "utf8") => {
      if (file.endsWith("-bundle.mjs")) {
        control.events.push("read");
        if (control.failure === "read") throw control.sentinel;
      }
      return fs.readFileSync(file, encoding);
    },
    rmSync: (file: string, options: { force: boolean; recursive: boolean }) => {
      control.events.push("cleanup");
      if (control.failure === "cleanup") throw new Error("cleanup sentinel");
      fs.rmSync(file, options);
    },
  };
});
vi.mock("node:child_process", async (original) => {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...await original<typeof import("node:child_process")>(),
    execFileSync: (command: string, args: string[], options: unknown) => {
      control.events.push("process");
      expect(command).toBe("bun"); expect(options).toEqual({ stdio: "pipe" });
      expect(args.slice(2, 4)).toEqual(["--format=esm", "--target=browser"]);
      if (control.failure === "process") throw new Error("process sentinel");
      if (control.failure === "missing-bun") throw new Error("spawn bun ENOENT");
      const output = args[4]!.slice("--outfile=".length);
      expect(dirname(output)).toBe(dirname(args[1]!));
      // Use the unmocked fs writer so the entry-write hook remains decisive.
      fs.writeFileSync(output, args[1]!.includes("mcp-bundle")
        ? "createMcpHandler createArtifactRegistry createArtifactCatalog IdentityError"
        : "handleOperationRequest IdentityError", "utf8");
    },
  };
});

for (const [label, build] of [["MCP", buildMcpBundle], ["HTTP", buildHttpOperationsBundle]] as const) {
  describe(`${label} defining builder scratch lifecycle`, () => {
    afterEach(() => {
      // Retain cleanup even for the baseline leak or injected cleanup refusal.
      control.failure = "";
      for (const directory of control.directories) rmSync(directory, { force: true, recursive: true });
      control.directories = []; control.events = []; control.failure = "";
    });
    it("cleans entry-write failure and preserves thrown identity before process demand", () => {
      control.failure = "write";
      let caught: unknown; try { build(); } catch (error) { caught = error; }
      expect(caught).toBe(control.sentinel);
      for (const directory of control.directories) expect(existsSync(directory)).toBe(false);
      expect(control.events).toEqual(["write", "cleanup"]);
    });
    it("cleans a partially written entry and preserves its original failure", () => {
      control.failure = "partial-write";
      let caught: unknown; try { build(); } catch (error) { caught = error; }
      expect(caught).toBe(control.sentinel);
      expect(control.events).toEqual(["write", "cleanup"]);
      expect(existsSync(control.directories[0]!)).toBe(false);
    });
    it("preserves a scalar entry-write failure while cleaning scratch", () => {
      control.failure = "scalar-write";
      let caught: unknown; try { build(); } catch (error) { caught = error; }
      expect(caught).toBe("write scalar");
      expect(control.events).toEqual(["write", "cleanup"]);
      expect(existsSync(control.directories[0]!)).toBe(false);
    });
    it("retains the first write failure if cleanup also fails, with scratch still present", () => {
      control.failure = "cleanup";
      let caught: unknown; try { build(); } catch (error) { caught = error; }
      expect(caught).toBe(control.sentinel);
      expect(control.events).toEqual(["write", "cleanup"]);
      expect(existsSync(control.directories[0]!)).toBe(true);
    });
    it("returns original successful contents and cleans after output read", () => {
      expect(build()).toBe(label === "MCP"
        ? "createMcpHandler createArtifactRegistry createArtifactCatalog IdentityError"
        : "handleOperationRequest IdentityError");
      expect(control.events).toEqual(["write", "process", "read", "cleanup"]);
      expect(existsSync(control.directories[0]!)).toBe(false);
    });
    it.each(["process", "missing-bun"] as const)("retains original %s failure mapping and cleanup order", (failure) => {
      control.failure = failure;
      const message = failure === "missing-bun"
        ? `deploy bundle: \`bun\` is not on PATH, needed to bundle the ${label === "MCP" ? "MCP handler" : "HTTP operations"} chain; install bun (https://bun.sh) or deploy via \`bun run\``
        : label === "MCP"
          ? "deploy bundle: MCP bundle build failed (`bun build` on the generated entry); the MCP SDK must resolve (run `bun install`) and both producer dists must be built. Underlying error: process sentinel"
          : "deploy bundle: HTTP bundle build failed (`bun build` on the generated entry); the interfaces dist must be built. Underlying error: process sentinel";
      expect(() => build()).toThrow(message);
      expect(control.events).toEqual(["write", "process", "cleanup"]);
      expect(existsSync(control.directories[0]!)).toBe(false);
    });
    it("preserves output-read thrown identity and cleanup", () => {
      control.failure = "read";
      let caught: unknown; try { build(); } catch (error) { caught = error; }
      expect(caught).toBe(control.sentinel);
      expect(control.events).toEqual(["write", "process", "read", "cleanup"]);
      expect(existsSync(control.directories[0]!)).toBe(false);
    });
  });
}
