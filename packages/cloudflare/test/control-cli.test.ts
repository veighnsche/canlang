import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDevControlOutput, runDevControlCli } from "../src/dev/control-cli.js";
import { startSessionSocket } from "../src/dev/session-socket.js";

const root = resolve(import.meta.dirname, "../../..");

describe("Node dev control entry", () => {
  it("emits one machine-readable envelope and separates usage from unavailable control", () => {
    const scratch = mkdtempSync(join(tmpdir(), "can-dev-cli-"));
    try {
      const installedPackage = join(root, "packages/cloudflare");
      const manifest = JSON.parse(readFileSync(join(installedPackage, "package.json"), "utf8")) as { bin: { "can-dev": string } };
      const entry = resolve(installedPackage, manifest.bin["can-dev"]);
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

  it("lists the first failure page through the CLI and owner socket with --after -1", async () => {
    const checkout = mkdtempSync(join(tmpdir(), "can-dev-cursor-"));
    const requests: unknown[] = [];
    const owner = await startSessionSocket({
      checkoutRoot: checkout, app: "Office", profile: "local-single-file",
      handle: command => {
        requests.push(command);
        return { schema: "can.dev.failures.v1", revision: "r3", failures: [{ ref: "s1/r3/d0" }], next_after: 0 };
      },
    });
    try {
      const lines: string[] = [];
      const code = await runDevControlCli([
        "failures", "--root", checkout, "--session", owner.identity.sessionId,
        "--revision", "r3", "--after", "-1", "--limit", "1",
      ], checkout, line => { lines.push(line); });
      expect(code).toBe(0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        ok: true, command: "failures", session: owner.identity.sessionId,
        result: { revision: "r3", failures: [{ ref: "s1/r3/d0" }], next_after: 0 },
      });
      expect(requests).toEqual([{ command: "failures", payload: { revision: "r3", after: -1, limit: 1 } }]);
    } finally {
      await owner.stop();
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
