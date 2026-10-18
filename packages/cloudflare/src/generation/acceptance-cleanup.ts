/** Reap only dev sessions explicitly owned by this candidate's browser checks. */
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

interface ControlResult { code: number; stdout: string }
export type AcceptanceCleanupControl = (args: string[], workspace: string) => Promise<ControlResult>;

const installedControl: AcceptanceCleanupControl = (args, workspace) => new Promise((done, reject) => {
  const binary = process.env.CAN_DEV_BIN ?? "can";
  const prefix = process.env.CAN_DEV_BIN === undefined ? ["dev"] : [];
  execFile(binary, [...prefix, ...args], {
    cwd: workspace, timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024,
  }, (error, stdout) => {
    if (error !== null && !(typeof error.code === "number" && !error.killed)) {
      reject(new Error("browser cleanup control command failed or exceeded its limit"));
      return;
    }
    done({ code: error?.code as number | undefined ?? 0, stdout });
  });
});

function response(result: ControlResult, command: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(result.stdout); }
  catch { throw new Error("browser cleanup control response is not JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (value as Record<string, unknown>).command !== command) {
    throw new Error("browser cleanup control response does not match the command");
  }
  return value as Record<string, unknown>;
}

function absent(result: ControlResult, body: Record<string, unknown>): boolean {
  return result.code === 1 && body.ok === false && body.code === "CONTROL_IO" &&
    body.detail === "No such file or directory (os error 2)";
}

/** The optional controller is host-test injection; generation requests cannot set it. */
export async function cleanupAcceptanceBrowsers(
  output: string, workspace: string, candidateSource: string,
  control: AcceptanceCleanupControl = installedControl,
): Promise<void> {
  let entries;
  try { entries = await readdir(output, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("browser cleanup could not read its output directory");
  }
  const owners = entries.filter(entry => /^browser-owner-.+\.json$/.test(entry.name));
  const records: { session: string; app: string }[] = [];
  // Validate every record before sending any stop command; never select by app alone.
  for (const entry of owners) {
    const path = join(output, entry.name);
    if (!entry.isFile() || (await stat(path)).size > 16 * 1024) {
      throw new Error("browser cleanup owner record must be a bounded regular file");
    }
    let record: Record<string, unknown>;
    try { record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; }
    catch { throw new Error("browser cleanup owner record is invalid JSON"); }
    if (record === null || typeof record !== "object" || Array.isArray(record) || record.owned !== true ||
        typeof record.workspace !== "string" || !isAbsolute(record.workspace) || resolve(record.workspace) !== resolve(workspace) ||
        typeof record.source !== "string" || !isAbsolute(record.source) || resolve(record.source) !== resolve(candidateSource) ||
        typeof record.session !== "string" || !/^[a-f0-9]{48}$/.test(record.session) ||
        typeof record.app !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(record.app)) {
      throw new Error("browser cleanup owner record does not match this candidate");
    }
    if (!records.some(saved => saved.session === record.session && saved.app === record.app)) {
      records.push({ session: record.session, app: record.app });
    }
  }
  let failures = 0;
  for (const owner of records) {
    try {
      const flags = ["--root", resolve(workspace), "--session", owner.session, "--app", owner.app, "--profile", "local-d1-identity"];
      const discovered = await control(["discover", ...flags], workspace);
      const found = response(discovered, "discover");
      if (absent(discovered, found)) continue;
      if (discovered.code !== 0 || found.ok !== true || found.session !== owner.session) {
        throw new Error("browser cleanup could not discover the owned session");
      }
      // The daemon may remove its endpoint before its stop response arrives.
      // Only discovery of this exact selector can establish successful cleanup.
      try { await control(["stop", ...flags], workspace); }
      catch { /* Verify absence below even when stop fails or times out. */ }
      const verified = await control(["discover", ...flags], workspace);
      if (!absent(verified, response(verified, "discover"))) {
        throw new Error("browser cleanup did not verify endpoint absence");
      }
    } catch { failures += 1; }
  }
  if (failures > 0) throw new Error(`browser cleanup failed for ${failures} owned session(s); promotion is refused`);
}
