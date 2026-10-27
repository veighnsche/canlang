/**
 * B25 upgrade coordinator: drives one reviewable `UpgradePlan` through the
 * State migration engine, one owner at a time, in `plan.from` order.
 *
 * BINDING (immutable predecessor/desired): every run re-verifies each
 * owner's compiled `MigrationTransition` via `validateTransition` against
 * the store's installed snapshot (predecessor) and the supplied desired
 * model tables (desired). A mismatch refuses before any write; an owner
 * already installed at the desired snapshot is skipped (idempotent).
 *
 * PERSISTENCE (no new record): the coordinator keeps no state of its own.
 * Engine `MigrationProgress` rows are the durable record; interruption
 * resume is a re-run with the same inputs. Admissions stay closed and
 * upgrades stay serialized by the deployer (engine fails loud on a
 * mis-schedule; see the S7 deployer protocol).
 *
 * FAILURE MAPPING: engine `failed` (or a leg throw) maps to L7
 * `staging-failed`/`activation-failed` from the recorded leg. A recorded
 * failure without an operator decision is unrecoverable (`recoverable:
 * false`); a deterministic phase-preserving leg error is retryable.
 *
 * Follow-ups (not this slice): plan compilation from artifacts,
 * drain/retain-compatible pending-work dispositions (inventories pass
 * through to the engine invalidate gate), wrangler-leg join, CLI.
 */
import type {
  MigrationFailureLeg,
  MigrationProgress,
  MigrationTransition,
  ModelName,
  OwnerSnapshotRef,
  StoragePort,
  UpgradePlan,
  UpgradeStage,
  UpgradeState,
  WorkInventoryItem,
} from '@canlang/contracts';
import type { ModelTable } from '@canlang/state';
import { StateError } from '@canlang/state/errors';
import {
  activate,
  readFailure,
  resumeMigration,
  stageNextChunk,
  validateStaged,
  validateTransition,
  type FailedDecision,
  type MigrationMapper,
  type OldLockSet,
  type RetainedSet,
  type ValidatedMigrationPlan,
} from '@canlang/state/migration';

/** Minimal engine clock (structural; no new export needed). */
export interface CoordinatorClock {
  nowMs(): number;
}

/** Per-owner compiled inputs (keyed by owner name in `CoordinateUpgradeInput`). */
export interface OwnerUpgradeInput {
  readonly transition: MigrationTransition;
  readonly mappers: ReadonlyMap<ModelName, MigrationMapper>;
  readonly oldModels: ModelTable;
  readonly desiredModels: ModelTable;
  readonly oldLocks: OldLockSet;
  readonly inventory: ReadonlyArray<WorkInventoryItem>;
  readonly retained?: RetainedSet | ReadonlySet<string>;
  /** Operator decision when this owner's engine state is `failed`. */
  readonly failedDecision?: FailedDecision;
}

export interface CoordinateUpgradeInput {
  readonly store: StoragePort;
  readonly plan: UpgradePlan;
  readonly owners: ReadonlyMap<string, OwnerUpgradeInput>;
  readonly chunkSize: number;
  readonly clock: CoordinatorClock;
}

function progressState(
  plan: UpgradePlan,
  stage: UpgradeStage,
  stagedOwners: number,
  failure?: UpgradeState['failure'],
): UpgradeState {
  return {
    stage,
    plan,
    progress: { stagedOwners, totalOwners: plan.from.length },
    ...(failure === undefined ? {} : { failure }),
  };
}

function failedState(
  plan: UpgradePlan,
  leg: MigrationFailureLeg,
  reason: string,
  stagedOwners: number,
  recoverable: boolean,
): UpgradeState {
  return progressState(plan, leg === 'staging' ? 'staging-failed' : 'activation-failed', stagedOwners, {
    reason,
    recoverable,
  });
}

function cursorKey(progress: MigrationProgress): string {
  return JSON.stringify([progress.phase, progress.stagedCursor, progress.publishCursor]);
}

/**
 * Drive one owner's engine migration to `active`. Returns the terminal
 * progress, or an L7 failure state when the engine refuses/fails.
 * Throws only on caller errors (unknown owner, unreadable inputs).
 */
async function driveOwner(
  store: StoragePort,
  plan: UpgradePlan,
  ref: OwnerSnapshotRef,
  input: OwnerUpgradeInput,
  chunkSize: number,
  clock: CoordinatorClock,
  stagedOwners: number,
): Promise<{ progress: MigrationProgress } | { failure: UpgradeState }> {
  const { transition } = input;
  if (transition.owner !== ref.owner || transition.fromSnapshotId !== ref.snapshotId) {
    throw new Error(
      `upgrade coordinator: transition ${JSON.stringify(transition.migrationId)} does not bind ` +
        `predecessor ${JSON.stringify(ref.owner)}/${JSON.stringify(ref.snapshotId)}.`,
    );
  }
  const installed = await store.readInstalledSnapshot(ref.owner);
  if (installed === null) {
    return {
      failure: failedState(
        plan,
        'staging',
        `upgrade coordinator: owner ${JSON.stringify(ref.owner)} has no installed snapshot; ` +
          `fresh installs never apply transitions.`,
        stagedOwners,
        false,
      ),
    };
  }
  if (installed.snapshotId === transition.toSnapshotId && installed.digest === transition.toDigest) {
    const progress = await store.readMigrationProgress(transition.migrationId);
    if (progress !== null && progress.phase !== 'active') {
      return {
        failure: failedState(
          plan,
          'activation',
          `upgrade coordinator: owner ${JSON.stringify(ref.owner)} is installed at the desired ` +
            `snapshot but migration ${JSON.stringify(transition.migrationId)} is ` +
            `${JSON.stringify(progress.phase)}; operator decision required.`,
          stagedOwners,
          false,
        ),
      };
    }
    // Already at desired (or its migration already active): idempotent skip.
    return {
      progress: progress ?? {
        migrationId: transition.migrationId,
        phase: 'active',
        stagedCursor: null,
        publishCursor: null,
        updatedRevision: installed.installedRevision,
      },
    };
  }
  let validated: ValidatedMigrationPlan;
  try {
    validated = validateTransition(installed, transition, input.oldModels, input.desiredModels);
  } catch (error) {
    return {
      failure: failedState(
        plan,
        'staging',
        `upgrade coordinator: owner ${JSON.stringify(ref.owner)} binding refused: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        stagedOwners,
        false,
      ),
    };
  }
  const resumeBase = {
    store,
    plan: validated,
    mappers: input.mappers,
    oldModels: input.oldModels,
    desiredModels: input.desiredModels,
    oldLocks: input.oldLocks,
    inventory: input.inventory,
    chunkSize,
    clock,
    ...(input.retained === undefined ? {} : { retained: input.retained }),
  };
  let leg: MigrationFailureLeg = 'staging';
  try {
    let progress = await store.readMigrationProgress(validated.migrationId);
    if (progress === null) {
      // Fresh staging: advance chunks (stall-guarded), then validate once.
      let lastCursor = '';
      for (;;) {
        const staged = await stageNextChunk({
          store,
          plan: validated,
          mappers: input.mappers,
          oldModels: input.oldModels,
          desiredModels: input.desiredModels,
          chunkSize,
        });
        progress = staged.progress;
        if (staged.done) break;
        const cursor = cursorKey(progress);
        if (cursor === lastCursor) {
          throw new StateError('validation', 'Migration staging stalled without advancing its cursor.');
        }
        lastCursor = cursor;
      }
      progress = await validateStaged({
        store,
        plan: validated,
        desiredModels: input.desiredModels,
        oldLocks: input.oldLocks,
        oldModels: input.oldModels,
      });
    }
    // Drain engine phases to active: staging chunks, staged activation,
    // interrupted publish completion, failed routing with the decision.
    for (;;) {
      const current = await store.readMigrationProgress(validated.migrationId);
      if (current === null) {
        throw new StateError('validation', 'Migration progress went missing mid-run.');
      }
      progress = current;
      if (progress.phase === 'active') break;
      if (progress.phase === 'staging' || progress.phase === 'staged') {
        if (progress.phase === 'staged') {
          leg = 'activation';
          await activate({
            store,
            plan: validated,
            inventory: input.inventory,
            oldModels: input.oldModels,
            desiredModels: input.desiredModels,
            chunkSize,
            clock,
            ...(input.retained === undefined ? {} : { retained: input.retained }),
          });
          continue;
        }
        const resumed = await resumeMigration(resumeBase);
        if (resumed.progress === null) {
          throw new StateError('validation', 'Migration staging aborted unexpectedly.');
        }
        progress = resumed.progress;
        continue;
      }
      if (
        progress.phase === 'releasing-claims' ||
        progress.phase === 'retaining-claims' ||
        progress.phase === 'publishing-rows' ||
        progress.phase === 'publishing'
      ) {
        leg = 'activation';
        const resumed = await resumeMigration(resumeBase);
        if (resumed.progress === null || resumed.progress.phase !== 'active') {
          throw new StateError('validation', 'Migration publish did not reach active.');
        }
        progress = resumed.progress;
        break;
      }
      // Engine `failed`: route with the operator decision, else map the leg.
      const failure = await readFailure(store, validated.migrationId);
      if (input.failedDecision === undefined) {
        return {
          failure: failedState(
            plan,
            failure?.leg ?? 'staging',
            `upgrade coordinator: owner ${JSON.stringify(ref.owner)} migration failed` +
              `${failure === null ? '' : ` during ${failure.leg}`} and no operator decision was supplied.`,
            stagedOwners,
            false,
          ),
        };
      }
      const resumed = await resumeMigration({ ...resumeBase, failedDecision: input.failedDecision });
      if (resumed.progress === null) {
        throw new StateError('validation', 'Migration abort discarded staged rows; re-run to restart.');
      }
      progress = resumed.progress;
    }
    return { progress };
  } catch (error) {
    if (error instanceof StateError) {
      // Deterministic leg error: engine preserved the phase for retry.
      return {
        failure: failedState(
          plan,
          leg,
          `upgrade coordinator: owner ${JSON.stringify(ref.owner)} leg refused: ${error.message}`,
          stagedOwners,
          true,
        ),
      };
    }
    return {
      failure: failedState(
        plan,
        leg,
        `upgrade coordinator: owner ${JSON.stringify(ref.owner)} unexpected failure: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        stagedOwners,
        false,
      ),
    };
  }
}

/**
 * Coordinate one upgrade plan to `active` (or the first owner failure).
 * Owners drive serially in `plan.from` order; the run is resumable by
 * re-invocation with the same inputs. Admissions stay closed and upgrades
 * stay serialized by the deployer.
 */
export async function coordinateUpgrade(input: CoordinateUpgradeInput): Promise<UpgradeState> {
  const { store, plan, owners, chunkSize, clock } = input;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`upgrade coordinator: invalid chunk size ${JSON.stringify(chunkSize)}.`);
  }
  let stagedOwners = 0;
  for (const ref of plan.from) {
    const owner = owners.get(ref.owner);
    if (owner === undefined) {
      throw new Error(`upgrade coordinator: no compiled transition for owner ${JSON.stringify(ref.owner)}.`);
    }
    const outcome = await driveOwner(store, plan, ref, owner, chunkSize, clock, stagedOwners);
    if ('failure' in outcome) return outcome.failure;
    // driveOwner returns progress only at `active` (or an idempotent skip).
    stagedOwners += 1;
  }
  return progressState(plan, 'active', stagedOwners);
}
