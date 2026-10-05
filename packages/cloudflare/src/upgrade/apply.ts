/**
 * B5-J3 upgrade executor: runs a reviewable `UpgradePlan` through its
 * staged `UpgradeState` machine.
 *
 * DRY-RUN IS THE DEFAULT: `applyUpgrade(plan)` with no options returns
 * the full staged transition sequence (`proposed` -> ... -> `active`)
 * with per-owner progress and performs NO side effects — no store
 * writes, no process spawns. It is the reviewable rehearsal of exactly
 * what a live apply would do.
 *
 * P-B wrangler leg: `runWranglerDeploy` IS the live wrangler-spawn
 * backend for the `deploy --yes` path — spawn happens ONLY with explicit
 * `yes: true` (the CLI `--yes`), and any other call refuses loudly
 * naming the by-hand equivalent (`manualApplyCommand`). `applyUpgrade`
 * live mode still refuses: the wrangler leg alone is not an upgrade
 * (staged state-store writes with resume from
 * `staging-failed`/`activation-failed` remain a follow-up), and a live
 * upgrade MUST NOT silently degrade to a bare worker deploy.
 */
import { execFileSync } from "node:child_process";
import type { UpgradePlan, UpgradeStage, UpgradeState } from "@canlang/contracts";

/** The live-apply stage order; dry-run walks the same path. */
export const UPGRADE_STAGE_ORDER: readonly UpgradeStage[] = [
  "proposed",
  "admissions-closed",
  "staging",
  "staged",
  "activating",
  "active",
];

export interface ApplyUpgradeOptions {
  /**
   * Default true. `false` means "perform the live apply" — which has no
   * backend yet and refuses loudly (never silently dry-runs a live ask).
   */
  dryRun?: boolean;
}

export interface ApplyUpgradeResult {
  dryRun: boolean;
  /** One state per stage walked, in stage order. */
  states: UpgradeState[];
  /** Human summary of what was (not) done. */
  message: string;
}

function stageState(plan: UpgradePlan, stage: UpgradeStage, stagedOwners: number): UpgradeState {
  return {
    stage,
    plan,
    progress: { stagedOwners, totalOwners: plan.from.length },
  };
}

/**
 * Execute the upgrade plan's stage machine. Dry-run (default) returns
 * the rehearsed states; live apply refuses until the staged store-write
 * backend lands (the wrangler leg alone is not an upgrade).
 */
export function applyUpgrade(plan: UpgradePlan, options: ApplyUpgradeOptions = {}): ApplyUpgradeResult {
  const dryRun = options.dryRun ?? true;
  if (!dryRun) {
    throw new Error(
      "upgrade apply: live apply has no backend yet — `runWranglerDeploy` covers the wrangler leg " +
        "only, and the staged state-store writes with resume (from `staging-failed`/" +
        "`activation-failed`) are still a follow-up. To move the worker by hand, run " +
        "`wrangler deploy --config <plan.wrangler.toml>` for the plan's rendered toml (then resume " +
        "the staged owners by hand) — or re-run without { dryRun: false } for the dry-run " +
        "rehearsal. Nothing was applied.",
    );
  }
  const totalOwners = plan.from.length;
  const states = UPGRADE_STAGE_ORDER.map((stage) => {
    const stagedOwners =
      stage === "proposed" || stage === "admissions-closed" || stage === "staging" ? 0 : totalOwners;
    return stageState(plan, stage, stagedOwners);
  });
  return {
    dryRun: true,
    states,
    message:
      `dry-run: rehearsed ${states.length} stages over ${totalOwners} owner(s); ` +
      `no state was written and wrangler was not spawned`,
  };
}

/* ------------------------------------------------------------------ */
/* P-B wrangler-spawn backend for the `deploy --yes` path.              */
/* ------------------------------------------------------------------ */

/** Backstop so a hung wrangler never hangs the CLI (default 3 minutes). */
export const WRANGLER_SPAWN_TIMEOUT_MS = 180_000;

export interface WranglerSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type WranglerSpawner = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => WranglerSpawnResult;

export interface WranglerDeployOptions {
  /**
   * Explicit live-apply confirmation (the CLI `--yes`). There is no other
   * way to spawn: `false` refuses loudly (dry-run default preserved) and
   * names the manual apply instead.
   */
  yes: boolean;
  /** Rendered `wrangler.toml` to deploy (absolute path preferred). */
  configPath: string;
  workingDir?: string;
  /** Injectable spawn (tests mock it; production uses `execFileSync`). */
  spawn?: WranglerSpawner;
  /** Spawn backstop in ms (default `WRANGLER_SPAWN_TIMEOUT_MS`). */
  timeoutMs?: number;
}

export interface WranglerDeployResult {
  /** True only when wrangler exited 0. */
  applied: boolean;
  command: readonly string[];
  status: number | null;
  stdout: string;
  stderr: string;
  /** The exact by-hand equivalent (for loud refusals and reports). */
  manualApply: string;
}

/** The exact by-hand equivalent of a wrangler-leg apply. */
export function manualApplyCommand(configPath: string): string {
  return `wrangler deploy --config ${JSON.stringify(configPath)}`;
}

interface ExecFailure extends Error {
  status?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

function defaultWranglerSpawn(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeout: number },
): WranglerSpawnResult {
  try {
    const stdout = execFileSync(command, [...args], {
      cwd: options.cwd,
      timeout: options.timeout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    // Nonzero exit carries a numeric status + captured output: reportable,
    // not throwable. Anything else (ENOENT, ETIMEDOUT/killed, signal) has
    // no trustworthy status and throws loud in the caller.
    const failure = error as ExecFailure;
    if (typeof failure.status === "number") {
      return {
        status: failure.status,
        stdout: typeof failure.stdout === "string" ? failure.stdout : String(failure.stdout ?? ""),
        stderr: typeof failure.stderr === "string" ? failure.stderr : String(failure.stderr ?? ""),
      };
    }
    throw error;
  }
}

/**
 * Spawn `wrangler deploy --config <toml>` — ONLY with explicit `yes`.
 * Without it, throws loudly naming the manual apply (never a silent
 * dry-run of a live ask, never a spawn). A nonzero exit returns
 * `applied: false` with captured output (the caller reports it loud);
 * a spawn-level failure (missing binary, timeout) throws loud because
 * no deploy outcome can be reported at all.
 */
export function runWranglerDeploy(options: WranglerDeployOptions): WranglerDeployResult {
  const manual = manualApplyCommand(options.configPath);
  if (!options.yes) {
    throw new Error(
      `refusing to spawn wrangler without explicit --yes (dry-run default: nothing was applied). ` +
        `To apply by hand, run: ${manual}`,
    );
  }
  const args = ["deploy", "--config", options.configPath] as const;
  const cwd = options.workingDir ?? process.cwd();
  const spawner = options.spawn;
  let result: WranglerSpawnResult;
  try {
    // Injected spies take no timeout; the default spawner always does.
    result =
      spawner !== undefined
        ? spawner("wrangler", args, { cwd })
        : defaultWranglerSpawn("wrangler", args, {
            cwd,
            timeout: options.timeoutMs ?? WRANGLER_SPAWN_TIMEOUT_MS,
          });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `deploy apply: wrangler spawn failed (${detail}); no deploy was performed — ` +
        `apply by hand: ${manual}`,
    );
  }
  return {
    applied: result.status === 0,
    command: ["wrangler", ...args],
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    manualApply: manual,
  };
}
