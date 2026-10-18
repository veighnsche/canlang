import { browserToolsRoot } from '../dev/browser-tools.js';
/** Mandatory app checks over candidate bytes. This module never promotes files. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAcceptanceBrowsers } from "./acceptance-cleanup.js";

export interface AppAcceptanceInput {
  /** Original application root, used only to select authored browser tests. */
  root: string;
  /** Frozen source and saved groups with the complete candidate set overlaid. */
  candidateRoot: string;
  files: string[];
  compiler: string;
  reportDir: string;
  /** Tooling root; installed candidates stay beneath their application root. */
  workspace?: string;
  onEvent?: (phase: string, detail: string) => void;
}

/** Injectable only by host tests; public generation requests cannot replace this gate. */
export type AppAcceptanceGate = (input: AppAcceptanceInput) => Promise<void>;

export class AppAcceptanceError extends Error {
  constructor(readonly stage: string, message: string) {
    super(`${stage}: ${message}`);
    this.name = "AppAcceptanceError";
  }
}

interface CommandResult { code: number | null; stdout: string; stderr: string }

/** Bound output and lifetime, and terminate the owned process group on timeout. */
export async function runAcceptanceCommand(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number;
}): Promise<CommandResult> {
  return new Promise((done, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { cwd: options.cwd, env: options.env,
      shell: false, detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", bytes = 0, failure: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      try { if (grouped && child.pid !== undefined) process.kill(-child.pid, signal); else child.kill(signal); }
      catch { /* already exited */ }
    };
    const stop = (message: string): void => {
      if (failure !== undefined) return;
      failure = new Error(message);
      kill("SIGTERM");
      force = setTimeout(() => kill("SIGKILL"), 1_000);
    };
    const timer = setTimeout(() => stop("command timed out"), options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) stop("command output exceeded 16 MiB");
      else stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) stop("command output exceeded 16 MiB");
      else stderr += chunk.toString("utf8");
    });
    child.once("error", error => { failure = error; });
    child.once("close", code => {
      clearTimeout(timer);
      if (force !== undefined) { clearTimeout(force); kill("SIGKILL"); }
      if (failure !== undefined) reject(failure);
      else done({ code, stdout, stderr });
    });
  });
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
  return value as Record<string, unknown>;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** Detect edits to test definitions during a run; captures and test results are outputs. */
async function testInputs(appDir: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (["node_modules", ".git", ".can", ".turbo", "target", "dist", "output", "coverage",
        "can.generated", "screenshots", "results", "test-results", "playwright-report"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`test inputs contain an unsupported symlink: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) {
        hash.update(relative(appDir, path)); hash.update(await readFile(path));
      }
    }
  }
  await walk(appDir);
  return hash.digest("hex");
}

/**
 * Reuse the actual compiler, platform build, D1 example executor and Playwright.
 * There is deliberately no "no tests" or unavailable-browser success fallback.
 */
type AcceptanceExecute = (name: string, command: string, args: string[], timeoutMs: number) => Promise<string>;

async function resolveAcceptanceRoots(input: AppAcceptanceInput) {
  const workspace = resolve(input.workspace ?? process.env.CAN_INSTALL_ROOT ?? process.cwd());
  const candidateRoot = resolve(input.candidateRoot);
  const installed = process.env.CAN_INSTALL_ROOT !== undefined;
  const executionRoot = installed ? candidateRoot : workspace;
  const reportPath = join(input.reportDir, "report.json");
  const rel = installed
    ? relative(await realpath(input.root), await realpath(candidateRoot))
    : relative(workspace, candidateRoot);
  if ((installed && rel === "") || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(installed ? "candidate must be beneath the application root" : "candidate must be inside the installed tooling workspace");
  }
  if (input.files.length === 0) throw new Error("acceptance requires an application source");
  return { workspace, candidateRoot, installed, executionRoot, reportPath };
}

async function resolveAcceptancePlaywright(installed: boolean, workspace: string) {
  const development = installed ? browserToolsRoot() : null;
  if (installed && development === null) {
    throw new Error('Browser development tools are not installed. Run the separate install-browser-tools.sh supplied with the release; browser acceptance remains required.');
  }
  let playwright: string;
  try { playwright = createRequire(join(development ?? workspace, "package.json")).resolve("@playwright/test/cli"); }
  catch (error) {
    if (installed && development === null && (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      throw new Error('Browser development tools are not installed. Run the separate install-browser-tools.sh supplied with the release; browser acceptance remains required.');
    }
    throw error;
  }
  return { development, playwright };
}

async function locateAcceptancePlaywrightConfig(appDir: string, file: string): Promise<string> {
  const configurations: string[] = [];
  for (const ext of ["ts", "mts", "cts", "js", "mjs", "cjs"]) {
    const path = join(appDir, `playwright.config.${ext}`);
    if (await exists(path)) configurations.push(path);
  }
  if (configurations.length !== 1) throw new Error(`${file} requires exactly one app-local playwright.config file`);
  return configurations[0]!;
}

async function runAcceptanceBuildSteps(
  execute: AcceptanceExecute,
  compiler: string,
  artifact: string,
  platform: string,
  catalog: string,
  candidate: string,
  executionRoot: string,
  passed: () => void,
): Promise<void> {
  const compiled = await execute("compile", compiler, ["compile", "--format=json", "--native-scenario-receipts",
    `--catalog=${catalog}`, relative(executionRoot, candidate)], 60_000);
  object(JSON.parse(compiled));
  await writeFile(artifact, compiled);
  passed();
  const build = object(JSON.parse(await execute("build", process.execPath, [platform, "build", "--artifact", artifact], 90_000)));
  if (build.ok !== true || build.command !== "build") throw new Error("build did not confirm success");
  passed();
  const tested = object(JSON.parse(await execute("test", process.execPath, [platform, "test", "--artifact", artifact], 330_000)));
  if (tested.ok !== true || tested.command !== "test" || typeof tested.executed !== "number" || tested.executed < 1) {
    throw new Error("app tests must execute at least one example and all must pass");
  }
  passed();
}

async function runAcceptancePlaywright(
  execute: AcceptanceExecute,
  output: string,
  executionRoot: string,
  candidate: string,
  installed: boolean,
  playwright: string,
  configuration: string,
): Promise<void> {
  await rm(join(output, "browser-session.json"), { force: true });
  await rm(join(output, "playwright.json"), { force: true });
  try {
    const moduleHook = installed ? ["--import", join(process.env.CAN_INSTALL_ROOT!, "libexec/module-resolution.mjs")] : [];
    await execute("playwright", process.execPath, [...moduleHook, playwright, "test", `--config=${configuration}`,
      "--reporter=json", "--retries=0", "--workers=1", "--global-timeout=300000", `--output=${join(output, "results")}`], 330_000);
  } finally {
    // Dev owners are detached from Playwright's process group. Reap the
    // registered candidate sessions even after a worker crash or timeout.
    await cleanupAcceptanceBrowsers(output, executionRoot, candidate);
  }
}

async function verifyAcceptanceBrowser(output: string, candidate: string, passed: () => void): Promise<void> {
  const browser = object(JSON.parse(await readFile(join(output, "playwright.json"), "utf8")));
  const stats = object(browser.stats);
  if (typeof stats.expected !== "number" || stats.expected < 1 || stats.unexpected !== 0 || stats.flaky !== 0 || stats.skipped !== 0 ||
      !Array.isArray(browser.errors) || browser.errors.length !== 0) {
    throw new Error("Playwright must execute tests without failures, skips, flaky results or errors");
  }
  const session = object(JSON.parse(await readFile(join(output, "browser-session.json"), "utf8")));
  if (session.source !== candidate || session.closed !== true ||
      typeof session.browserNavigations !== "number" || session.browserNavigations < 1 ||
      typeof session.sourceRevision !== "string" || session.sourceRevision.length === 0 ||
      typeof session.servingBuild !== "string" || session.servingBuild.length === 0) {
    throw new Error("Playwright did not verify and close the candidate's real dev-server session");
  }
  passed();
}

export const runAppAcceptance: AppAcceptanceGate = async input => {
  const reportPath = join(input.reportDir, "report.json");
  const checks: { source: string; stage: string; ok: boolean; detail?: string }[] = [];
  let stage = "setup", source = "";
  await mkdir(input.reportDir, { recursive: true });
  const report = async (ok: boolean): Promise<void> => writeFile(reportPath,
    `${JSON.stringify({ version: 1, ok, checks }, null, 2)}\n`);
  try {
    const { workspace, candidateRoot, installed, executionRoot } = await resolveAcceptanceRoots(input);
    const platform = fileURLToPath(new URL("../cli/platform.js", import.meta.url));
    const { development, playwright } = await resolveAcceptancePlaywright(installed, workspace);
    const catalog = process.env["CAN_CATALOG"] ?? join(workspace, "packages/values/dist/catalog.json");
    for (const [index, file] of [...new Set(input.files)].sort().entries()) {
      stage = "setup";
      source = file;
      const original = resolve(input.root, file);
      const candidate = resolve(candidateRoot, file);
      const appDir = dirname(original);
      const configuration = await locateAcceptancePlaywrightConfig(appDir, file);
      const testsBefore = await testInputs(appDir);
      const output = join(input.reportDir, String(index + 1));
      await mkdir(output, { recursive: true });
      const env = { ...process.env, ...(development === null ? {} : { CAN_BROWSER_TOOLS_ROOT: development, PLAYWRIGHT_BROWSERS_PATH: join(development, "browsers") }), CAN_COMPILER_BIN: resolve(input.compiler),
        CAN_ACCEPTANCE_SOURCE: candidate, CAN_ACCEPTANCE_WORKSPACE: executionRoot, CAN_ACCEPTANCE_OUTPUT: output,
        PLAYWRIGHT_JSON_OUTPUT_FILE: join(output, "playwright.json") };
      const execute = async (name: string, command: string, args: string[], timeoutMs: number): Promise<string> => {
        stage = name;
        input.onEvent?.("acceptance", `${file}: ${name}`);
        const result = await runAcceptanceCommand(command, args, { cwd: executionRoot, env, timeoutMs });
        await writeFile(join(output, `${name}.stdout.log`), result.stdout);
        await writeFile(join(output, `${name}.stderr.log`), result.stderr);
        if (result.code !== 0) throw new Error(`exited ${String(result.code)}; see ${output}`);
        return result.stdout;
      };
      const passed = (): void => { checks.push({ source, stage, ok: true }); };
      const artifact = join(output, "candidate.artifact.json");
      await runAcceptanceBuildSteps(execute, input.compiler, artifact, platform, catalog, candidate, executionRoot, passed);
      await runAcceptancePlaywright(execute, output, executionRoot, candidate, installed, playwright, configuration);
      await verifyAcceptanceBrowser(output, candidate, passed);
      stage = "inputs";
      if (await testInputs(appDir) !== testsBefore) throw new Error("app test definitions changed during acceptance; rerun against stable inputs");
    }
    await report(true);
    input.onEvent?.("acceptance", `all app checks passed; ${reportPath}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({ source, stage, ok: false, detail });
    await report(false);
    throw new AppAcceptanceError(stage, `${detail}. Current outputs are unchanged. Report: ${reportPath}`);
  }
};
