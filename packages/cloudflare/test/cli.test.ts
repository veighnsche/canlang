import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = new URL("../dist/cli/platform.js", import.meta.url);

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

function fixtureArtifact(): string {
  const dir = mkdtempSync(join(tmpdir(), "can-platform-"));
  const path = join(dir, "artifact.json");
  writeFileSync(path, JSON.stringify({ note: "opaque to the CLI" }));
  return path;
}

describe("can-platform CLI (L1 IR-03 delegation target)", () => {
  it("--version prints the identity envelope", async () => {
    const result = await runCli(["--version"]);
    expect(result.code).toBe(0);
    expect(envelope(result.stdout)).toEqual({
      ok: true,
      name: "can-platform",
      version: "0.1.0",
    });
  });

  it("--help still emits exactly one envelope (exit 0)", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: true, name: "can-platform", version: "0.1.0" });
    expect(typeof body["usage"]).toBe("string");
    expect(result.stderr).toContain("Usage:");
  });

  it("-h and -V match their long aliases", async () => {
    const help = await runCli(["-h"]);
    expect(help.code).toBe(0);
    const helpBody = envelope(help.stdout);
    expect(helpBody).toMatchObject({ ok: true, name: "can-platform", version: "0.1.0" });
    expect(typeof helpBody["usage"]).toBe("string");
    const version = await runCli(["-V"]);
    expect(version.code).toBe(0);
    expect(envelope(version.stdout)).toEqual({
      ok: true,
      name: "can-platform",
      version: "0.1.0",
    });
  });

  it("--env is accepted and still reaches the producer gate", async () => {
    const result = await runCli(["run", "--artifact", fixtureArtifact(), "--env", "staging"]);
    expect(result.code).toBe(2);
    expect(envelope(result.stdout)).toMatchObject({
      ok: false,
      command: "run",
      code: "missing-producer",
    });
  });

  it("duplicate flags are a usage failure", async () => {
    const path = fixtureArtifact();
    const dupArtifact = await runCli(["run", "--artifact", path, "--artifact", path]);
    expect(dupArtifact.code).toBe(2);
    expect(envelope(dupArtifact.stdout)).toMatchObject({ ok: false, code: "usage" });
    const dupEnv = await runCli(["run", "--artifact", path, "--env", "a", "--env", "b"]);
    expect(dupEnv.code).toBe(2);
    expect(envelope(dupEnv.stdout)).toMatchObject({ ok: false, code: "usage" });
  });

  it.each([["--help"], ["-h"]])("%s after a subcommand answers help (L1 verbatim passthrough)", async (flag) => {
    const result = await runCli(["run", flag]);
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: true, name: "can-platform", version: "0.1.0" });
    expect(typeof body["usage"]).toBe("string");
    expect(result.stderr).toContain("Usage:");
  });

  it("trailing flag without a value is a usage failure", async () => {
    const result = await runCli(["run", "--artifact"]);
    expect(result.code).toBe(2);
    expect(envelope(result.stdout)).toMatchObject({ ok: false, code: "usage" });
  });

  it("no command is a usage failure", async () => {
    const result = await runCli([]);
    expect(result.code).toBe(2);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: false, code: "usage" });
    expect(result.stderr).toContain("Usage:");
  });

  it("unknown command is a usage failure", async () => {
    const result = await runCli(["frobnicate", "--artifact", "x"]);
    expect(result.code).toBe(2);
    expect(envelope(result.stdout)).toMatchObject({ ok: false, code: "usage" });
  });

  it("missing --artifact is a usage failure", async () => {
    const result = await runCli(["run"]);
    expect(result.code).toBe(2);
    expect(envelope(result.stdout)).toMatchObject({ ok: false, code: "usage" });
  });

  it("unreadable artifact reports missing-artifact, not a producer error", async () => {
    const result = await runCli(["run", "--artifact", join(tmpdir(), "does-not-exist-7.can")]);
    expect(result.code).toBe(2);
    expect(envelope(result.stdout)).toMatchObject({
      ok: false,
      command: "run",
      code: "missing-artifact",
    });
  });

  it.each(["run", "test", "build", "deploy"])(
    "%s with a present artifact reports the exact missing producer",
    async (command) => {
      const result = await runCli([command, "--artifact", fixtureArtifact()]);
      expect(result.code).toBe(2);
      const body = envelope(result.stdout);
      expect(body).toMatchObject({
        ok: false,
        command,
        code: "missing-producer",
        producer: "lane-01",
      });
      expect(typeof body["contract"]).toBe("string");
      expect(typeof body["detail"]).toBe("string");
    },
  );
});
