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
 * live mode still refuses (it is the dry-run rehearsal; a live upgrade
 * MUST NOT silently degrade to a bare worker deploy): live applies go
 * through `liveApplyUpgrade`, which stages every owner, deploys the
 * worker, then flips, with resume from
 * `staging-failed`/`activation-failed`.
 */
import { execFileSync } from "node:child_process";
import type { StoragePort, UpgradePlan, UpgradeStage, UpgradeState } from "@canlang/contracts";
import {
  coordinateUpgrade,
  type CoordinatorClock,
  type OwnerUpgradeInput,
} from "./coordinate.js";

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
      "upgrade apply: this entry is the dry-run rehearsal only — live applies go through " +
        "`liveApplyUpgrade` (stage every owner, deploy the worker, then flip, with resume " +
        "from `staging-failed`/`activation-failed`). To move the worker by hand, run " +
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
/* Live apply backend: staged data migration + worker deploy + flip.     */
/* ------------------------------------------------------------------ */

export interface LiveApplyUpgradeInput {
  readonly plan: UpgradePlan;
  readonly owners: ReadonlyMap<string, OwnerUpgradeInput>;
  readonly store: StoragePort;
  readonly chunkSize: number;
  readonly clock: CoordinatorClock;
  /** Explicit live-apply confirmation (the CLI `--yes`); false refuses. */
  readonly yes: boolean;
  /** Rendered `wrangler.toml` to deploy (absolute path preferred). */
  readonly configPath: string;
  readonly workingDir?: string;
  /** Injectable spawn (tests mock it; production uses `execFileSync`). */
  readonly spawn?: WranglerSpawner;
  readonly timeoutMs?: number;
}

export interface LiveApplyUpgradeResult {
  readonly state: UpgradeState;
  /** Present exactly when the deploy leg ran. */
  readonly wrangler?: WranglerDeployResult;
}

/**
 * Live upgrade: stage every owner, deploy the worker, then flip.
 * Deploy-then-flip keeps the slow fallible deploy outside the flip: a
 * deploy failure leaves old-code/old-data consistent (staged rows stay
 * resumable), and the skew window shrinks to the seconds between deploy
 * finish and flip start. Without `yes` nothing runs at all — no staging,
 * no spawn. A wrangler nonzero exit is retryable (`activation-failed`,
 * recoverable); a spawn-level failure needs operator inspection first.
 * Admissions stay closed and upgrades stay serialized by the deployer.
 */
export async function liveApplyUpgrade(input: LiveApplyUpgradeInput): Promise<LiveApplyUpgradeResult> {
  const { plan, owners, store, chunkSize, clock, yes, configPath, workingDir, spawn, timeoutMs } = input;
  if (!yes) {
    throw new Error(
      `refusing live upgrade without explicit --yes (dry-run default: nothing was applied). ` +
        `To apply by hand, run: ${manualApplyCommand(configPath)}`,
    );
  }
  const staged = await coordinateUpgrade({ store, plan, owners, chunkSize, clock, stopBeforeActivate: true });
  if (staged.stage !== 'staged' && staged.stage !== 'active') {
    return { state: staged };
  }
  let wrangler: WranglerDeployResult;
  try {
    wrangler = runWranglerDeploy({
      yes: true,
      configPath,
      ...(workingDir === undefined ? {} : { workingDir }),
      ...(spawn === undefined ? {} : { spawn }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  } catch (error) {
    return {
      state: {
        stage: 'activation-failed',
        plan,
        progress: staged.progress,
        failure: {
          reason:
            `upgrade deploy leg failed before confirmation: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          recoverable: false,
        },
      },
    };
  }
  if (!wrangler.applied) {
    return {
      state: {
        stage: 'activation-failed',
        plan,
        progress: staged.progress,
        failure: {
          reason:
            `upgrade deploy leg exited ${String(wrangler.status)}; data stays staged and resumable. ` +
            `To apply by hand, run: ${wrangler.manualApply}`,
          recoverable: true,
        },
      },
      wrangler,
    };
  }
  const state = await coordinateUpgrade({ store, plan, owners, chunkSize, clock });
  return { state, wrangler };
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
 * the remote outcome is unconfirmed and must be inspected before retry.
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
      `deploy apply: wrangler spawn failed (${detail}); remote outcome unconfirmed. ` +
        `Inspect the deployment before any manual retry: ${manual}`,
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
