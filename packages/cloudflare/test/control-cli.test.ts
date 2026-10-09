import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDevControlOutput } from "../src/dev/control-cli.js";

const root = resolve(import.meta.dirname, "../../..");

describe("Node dev control entry", () => {
  it("emits one machine-readable envelope and separates usage from unavailable control", () => {
    const scratch = mkdtempSync(join(tmpdir(), "can-dev-cli-"));
    try {
      const entry = join(scratch, "control.mjs");
      const built = spawnSync("bun", ["build", "packages/cloudflare/src/dev/control-cli.ts", "--target=node", `--outfile=${entry}`], {
        cwd: root, encoding: "utf8",
      });
      expect(built.status, built.stderr).toBe(0);
      const invoke = (args: string[]) => {
        const result = spawnSync(process.execPath, [entry, ...args], { cwd: root, encoding: "utf8" });
        expect(result.stderr).toBe("");
        expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
        return { status: result.status, body: JSON.parse(result.stdout) as Record<string, unknown> };
      };
      expect(invoke(["help"])).toMatchObject({ status: 0, body: { ok: true, result: { schema: "can.dev.control-help.v1" } } });
      expect(invoke(["unknown"])).toMatchObject({ status: 2, body: { ok: false, code: "UNKNOWN_COMMAND" } });
      expect(invoke(["status", "--root", scratch])).toMatchObject({ status: 1, body: { ok: false, code: "CONTROL_UNAVAILABLE" } });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("keeps observed source errors as successful control results and bounds output", () => {
    const checked = formatDevControlOutput({
      ok: true, command: "check", session: "s1", result: { state: "errors", focus: { code: "E1200" } },
    });
    expect(checked.exitCode).toBe(0);
    expect(JSON.parse(checked.line)).toMatchObject({ ok: true, result: { state: "errors" } });
    expect(formatDevControlOutput({ ok: true, command: "check", session: "s1", result: "x".repeat(140_000) }))
      .toMatchObject({ exitCode: 1 });
  });
});
