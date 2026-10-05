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
 * LIVE APPLY IS A FOLLOW-UP: `dryRun: false` refuses loudly. The live
 * backend (wrangler spawn for worker deploy + staged state-store writes
 * with resume from `staging-failed`/`activation-failed`) is not
 * implemented; this module never spawns wrangler and never touches the
 * network. When the backend lands, it executes THESE stages in THIS
 * order — the dry-run sequence is the contract.
 */
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
 * the rehearsed states; live apply refuses until the wrangler/store
 * backend lands (follow-up).
 */
export function applyUpgrade(plan: UpgradePlan, options: ApplyUpgradeOptions = {}): ApplyUpgradeResult {
  const dryRun = options.dryRun ?? true;
  if (!dryRun) {
    throw new Error(
      "upgrade apply: live apply has no backend yet (follow-up: wrangler spawn + staged state-store " +
        "writes with resume). Re-run without { dryRun: false } for the dry-run rehearsal — nothing was applied.",
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
