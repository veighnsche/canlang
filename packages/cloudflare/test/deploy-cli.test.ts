import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = new URL("../dist/cli/platform.js", import.meta.url);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], timeout = 15000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI.pathname, ...args],
      { timeout },
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

const SHA = "b".repeat(64);

/** Minimal valid CompileArtifact v1 (loader-strict). */
function validArtifact(): Record<string, unknown> {
  return {
    artifact_version: 1,
    language_version: "1.0.0",
    tool_version: "0.1.0",
    sources: [{ path: "app.can", sha256: SHA }],
    modules: [
      {
        path: "worker.mjs",
        js: "export default { async fetch() { return new Response(\"ok\"); } };\n",
        map: { version: 3, file: "worker.mjs", sources: [], sourcesContent: [], names: [], mappings: "" },
      },
    ],
    callables: [],
    pages: [],
    requires: [],
    tests: [],
  };
}

/** Deploy bundle next to the artifact (activate bundle convention). */
function deployBundle(): { dir: string; artifact: string } {
  const dir = mkdtempSync(join(tmpdir(), "can-deploy-cli-"));
  const artifact = join(dir, "teamtasks.artifact.json");
  writeFileSync(artifact, JSON.stringify(validArtifact()));
  writeFileSync(
    join(dir, "teamtasks.descriptor.json"),
    JSON.stringify({
      identity: {
        appName: "TeamTasks",
        sourceRevision: "14fa6a0",
        languageVersion: "1.0.0",
        compilerVersion: "0.1.0",
        contractsVersion: 1,
        artifactDigest: "digest-fixture",
      },
      requiredCapabilities: [],
      resourceBindings: [{ binding: "DB", kind: "d1", logicalName: "teamtasks-db" }],
      secrets: [],
      schedules: [],
    }),
  );
  writeFileSync(
    join(dir, "teamtasks.prod.environment.json"),
    JSON.stringify({
      environment: "prod",
      resources: [
        {
          requirement: { binding: "DB", kind: "d1", logicalName: "teamtasks-db" },
          resourceId: "db-123",
        },
      ],
      secretsPresent: [],
      vars: { API_URL: "https://api.example.com" },
    }),
  );
  writeFileSync(
    join(dir, "teamtasks.target.json"),
    JSON.stringify({
      contractsVersion: 1,
      runtimeVersion: "0.1.0",
      knownLanguageVersions: ["1.0.0"],
      capabilities: [],
      supportsSchedules: false,
    }),
  );
  return { dir, artifact };
}

describe("can-platform deploy/test/build local paths (B5-J3)", () => {
  it("deploy --preview prints a human-diffable plan and writes nothing", async () => {
    const { dir, artifact } = deployBundle();
    const result = await runCli(["deploy", "--artifact", artifact, "--env", "prod", "--preview"]);
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: true, command: "deploy", preview: true, wrote: false });
    expect(body["plan"]).toBeDefined();
    expect(body["changed"]).toBe(true);
    expect(result.stderr).toContain("teamtasks");
    expect(existsSync(join(dir, "teamtasks.deploy-plan.json"))).toBe(false);
    expect(existsSync(join(dir, "teamtasks.wrangler.toml"))).toBe(false);
  });

  it("bare deploy blocks: confirm gate requires --preview or --yes", async () => {
    const { artifact } = deployBundle();
    const result = await runCli(["deploy", "--artifact", artifact, "--env", "prod"]);
    expect(result.code).toBe(2);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: false, command: "deploy", code: "confirm-required" });
    expect(String(body["detail"])).toContain("--yes");
  });

  it("deploy --yes writes plan files; second preview shows no changes", async () => {
    const { dir, artifact } = deployBundle();
    const first = await runCli(["deploy", "--artifact", artifact, "--env", "prod", "--yes"]);
    expect(first.code).toBe(0);
    const firstBody = envelope(first.stdout);
    expect(firstBody).toMatchObject({ ok: true, command: "deploy", wrote: true });
    expect(existsSync(join(dir, "teamtasks.deploy-plan.json"))).toBe(true);
    const toml = join(dir, "teamtasks.wrangler.toml");
    expect(existsSync(toml)).toBe(true);
    const second = await runCli(["deploy", "--artifact", artifact, "--env", "prod", "--preview"]);
    expect(second.code).toBe(0);
    expect(envelope(second.stdout)).toMatchObject({ changed: false });
    // C3: two CLI runs × two bun bundles each (MCP + HTTP op chain)
    // exceed the 5s default under load; bounded explicit timeout.
  }, 30000);

  it("deploy refuses an incompatible bundle (compat gate first)", async () => {
    const { artifact } = deployBundle();
    const bad = join(artifact, "..", "teamtasks.prod.environment.json");
    const env = JSON.parse(
      (await import("node:fs")).readFileSync(bad, "utf8") as unknown as string,
    ) as { resources: unknown[]; [key: string]: unknown };
    env.resources = [];
    writeFileSync(bad, JSON.stringify(env));
    const result = await runCli(["deploy", "--artifact", artifact, "--env", "prod", "--preview"]);
    expect(result.code).toBe(2);
    expect(envelope(result.stdout)).toMatchObject({ ok: false, command: "deploy", code: "incompatible" });
  });

  it("build validates the artifact and reports the release", async () => {
    const { artifact } = deployBundle();
    const result = await runCli(["build", "--artifact", artifact]);
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: true, command: "build", release: "0.1.0" });
    expect(body["modules"]).toBe(1);
  });

  it("test refuses zero-row success until the compiled row producer is joined", async () => {
    const { artifact } = deployBundle();
    const result = await runCli(["test", "--artifact", artifact], 90000);
    expect(result.code).toBe(2);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: false, command: "test", code: "missing-producer" });
    expect(String(body["detail"])).toContain("zero-row results cannot pass");
  }, 100000);
});
