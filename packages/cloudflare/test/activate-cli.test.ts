/**
 * B3-I6 `can-platform activate` demo tests (TeamTasks bundle).
 *
 * Failing-first: written before the `activate` command existed. Runs the
 * built CLI (`dist/`, same pattern as `cli.test.ts`) against the
 * hand-written TeamTasks activation bundle in
 * `test/fixtures/teamtasks-activate/` (NOT compiler output).
 *
 * Honest scope: the CLI can run gates 1-3 (compat, requires, digest)
 * from bundle data, but the outstanding-work inventory gate needs the
 * `@canlang/state` + `@canlang/work` producer runtimes, which are not
 * importable from the plain-node dist CLI — so even the good bundle
 * reports `active: false` with `activation-incomplete` for gate 4. The
 * full-pass verdict (all four gates, real producer functions) is proven
 * in `activate.test.ts`.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = new URL("../dist/cli/platform.js", import.meta.url);
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "teamtasks-activate");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI.pathname, ...args],
      { timeout: 15000 },
      (error, stdout, stderr) => {
        const code =
          error !== null && "code" in error && typeof error.code === "number" ? error.code : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function envelope(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string) as Record<string, unknown>;
}

describe("can-platform activate (TeamTasks demo)", () => {
  it("fails closed on the bad bundle (requires values.decimal, target lacks it)", async () => {
    const result = await runCli([
      "activate",
      "--artifact",
      join(FIXTURES, "teamtasks-bad.artifact.json"),
      "--env",
      "local",
    ]);
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(body["ok"]).toBe(true);
    expect(body["command"]).toBe("activate");
    expect(body["active"]).toBe(false);
    const reasons = body["reasons"] as { code: string; detail: string }[];
    expect(reasons[0]?.code).toBe("missing-capability");
    expect(reasons[0]?.detail).toContain("values.decimal");
  });

  it("runs gates 1-3 on the good bundle, names the gate-4 producer join", async () => {
    const result = await runCli([
      "activate",
      "--artifact",
      join(FIXTURES, "teamtasks-good.artifact.json"),
      "--env",
      "local",
    ]);
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: true, command: "activate", active: false });
    expect(body["reasons"]).toEqual([
      { code: "activation-incomplete", detail: expect.stringContaining("inventory") },
    ]);
  });

  it("requires --env for activate", async () => {
    const result = await runCli(["activate", "--artifact", join(FIXTURES, "teamtasks-good.artifact.json")]);
    expect(result.code).toBe(2);
    expect(envelope(result.stdout)).toMatchObject({ ok: false, code: "usage" });
  });

  it("reports a missing bundle file loudly, not a producer error", async () => {
    const result = await runCli([
      "activate",
      "--artifact",
      join(FIXTURES, "teamtasks-missing.artifact.json"),
      "--env",
      "local",
    ]);
    expect(result.code).toBe(2);
    expect(envelope(result.stdout)).toMatchObject({ ok: false, command: "activate" });
  });
});
