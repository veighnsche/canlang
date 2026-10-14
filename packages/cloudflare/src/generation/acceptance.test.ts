import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AppAcceptanceError, runAcceptanceCommand, runAppAcceptance } from "./acceptance.js";

const workspace = fileURLToPath(new URL("../../../../", import.meta.url));

test("acceptance command captures a real process result and preserves nonzero exit", async () => {
  const options = { cwd: workspace, env: process.env, timeoutMs: 5_000 };
  const success = await runAcceptanceCommand(process.execPath,
    ["-e", 'process.stdout.write("checked");process.stderr.write("diagnostic")'], options);
  assert.deepEqual(success, { code: 0, stdout: "checked", stderr: "diagnostic" });
  const failure = await runAcceptanceCommand(process.execPath,
    ["-e", 'process.stdout.write("failed");process.exitCode=7'], options);
  assert.equal(failure.code, 7);
  assert.equal(failure.stdout, "failed");
});

test("acceptance command times out and reaps a process that ignores SIGTERM", { timeout: 7_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "can-acceptance-timeout-"));
  const pidPath = join(scratch, "pid");
  try {
    await assert.rejects(runAcceptanceCommand(process.execPath, ["-e",
      'require("node:fs").writeFileSync(process.argv[1],String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
      pidPath], { cwd: workspace, env: process.env, timeoutMs: 1_000 }), /command timed out/);
    const pid = Number(await readFile(pidPath, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return true;
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("app acceptance fails before execution when app-local browser configuration is absent", async () => {
  const scratch = await mkdtemp(join(workspace, ".can-acceptance-test-"));
  try {
    const reportDir = join(scratch, "report");
    await assert.rejects(runAppAcceptance({ root: scratch, candidateRoot: join(scratch, "candidate"),
      files: ["Probe.can"], compiler: process.execPath, reportDir, workspace }), (error: unknown) => {
      assert.ok(error instanceof AppAcceptanceError);
      assert.equal(error.stage, "setup");
      assert.match(error.message, /requires exactly one app-local playwright.config/);
      return true;
    });
    const report = JSON.parse(await readFile(join(reportDir, "report.json"), "utf8"));
    assert.equal(report.ok, false);
    assert.deepEqual(report.checks.map((check: { stage: string; ok: boolean }) => [check.stage, check.ok]), [["setup", false]]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("app acceptance fails when its workspace has no installed browser runner", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "can-acceptance-no-browser-"));
  try {
    await writeFile(join(scratch, "package.json"), '{"private":true}\n');
    await mkdir(join(scratch, "candidate"));
    const reportDir = join(scratch, "report");
    await assert.rejects(runAppAcceptance({ root: scratch, candidateRoot: join(scratch, "candidate"),
      files: ["Probe.can"], compiler: process.execPath, reportDir, workspace: scratch }), (error: unknown) => {
      assert.ok(error instanceof AppAcceptanceError);
      assert.equal(error.stage, "setup");
      assert.match(error.message, /@playwright\/test/);
      return true;
    });
    const report = JSON.parse(await readFile(join(reportDir, "report.json"), "utf8"));
    assert.equal(report.ok, false);
    assert.equal(report.checks.some((check: { ok: boolean }) => check.ok), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
