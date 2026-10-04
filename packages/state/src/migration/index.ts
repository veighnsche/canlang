/**
 * Lane 03 S7: migration execution barrel + resume.
 *
 * L7 `UpgradeState` PHASE MAPPING (documented at this join; L7 owns the
 * `UpgradeState` type, the engine owns `MigrationPhase`):
 * - engine `staging`    -> L7 `staging`   (bounded chunks in flight)
 * - engine `staged`      -> L7 `staged`    (validated, awaiting activation)
 * - engine `publishing`  -> L7 `activating` (publish chunks + flip in flight)
 * - engine `active`      -> L7 `active`    (flip committed)
 * - engine `failed`      -> L7 `staging-failed` when the failure happened
 *   before the flip, `activation-failed` when it happened during publish
 *   or flip. The engine never writes `failed` itself (see below), so L7
 *   derives which leg failed from the call that threw: staging/validate
 *   legs map to `staging-failed`, publish/flip legs to
 *   `activation-failed`.
 *
 * CONTRACT GAP (loud): the `failed` phase has no writer. The engine
 * throws without recording `failed` (phases advance only forward from
 * engine writes), and no storage intake sets it either. Until a writer
 * lands, L7 records operator-visible failure in `UpgradeState` and the
 * stored `MigrationProgress` keeps its last successful phase, so resume
 * retries from the last committed cursor. Flagged for the coordinator.
 *
 * DEPLOYER PROTOCOL (loud): same-owner migrations run SERIALIZED by the
 * deployer (L7), with admissions closed for the whole run (DESIGN §11.3).
 * The engine holds no cross-migration lock: staging/progress rows are
 * keyed by migration id (concurrent ids would interleave publish writes
 * onto one layout), and only the shared revision fence plus the
 * activation evidence gate (predecessor re-verified before any row moves;
 * flip no-ops throw) stand between a mis-schedule and corruption. A
 * concurrent same-owner migration therefore fails loud (busy or
 * validation), never silently — but L7 must still never schedule one.
 */

import type {
  FlipResult,
  MigrationProgress,
  ModelName,
  StoragePort,
  StoredRow,
  WorkInventoryItem,
} from '../../../contracts/src/state.js';
import type { ClockPort } from '../invocation/context.js';
import type { ModelTable } from '../mutation/models.js';
import { StateError } from '../errors.js';
import {
  checkActivationInventory,
  flipToInstalled,
  publishStagedAndDrops,
} from './activate.js';
import type { MigrationMapper } from './mapper.js';
import { stageNextChunk } from './stage.js';
import { validateStaged, type OldLockSet } from './validate.js';
import type { ValidatedMigrationPlan } from './transition.js';

export {
  freshInstallSnapshot,
  validateTransition,
  type FreshInstallInput,
  type ValidatedFieldMapping,
  type ValidatedMigrationPlan,
  type ValidatedModelKind,
  type ValidatedModelMapping,
  type ValidatedOwnerAction,
} from './transition.js';
export {
  createMigrationRowBuilder,
  freezeBeforeRow,
  validateMappedRow,
  type FrozenBeforeRow,
  type MigrationMapper,
  type MigrationRowBuilder,
  type SeededMigrationRowBuilder,
} from './mapper.js';
export {
  stageNextChunk,
  type StageNextChunkInput,
  type StageNextChunkResult,
} from './stage.js';
export {
  canonicalUniqueValue,
  validateStaged,
  type OldLockSet,
  type ValidateStagedInput,
} from './validate.js';
export {
  activate,
  checkActivationInventory,
  flipToInstalled,
  publishStagedAndDrops,
  type ActivateInput,
  type ActivationDisposition,
} from './activate.js';

/**
 * Full resume bag: L7 supplies everything every phase may need (resume
 * routes by stored phase). Only `isExpiredRow` is optional (absent until
 * L1 lifetime descriptors land; see `stage.ts`).
 */
export interface ResumeMigrationInput {
  readonly store: StoragePort;
  readonly plan: ValidatedMigrationPlan;
  readonly mappers: ReadonlyMap<ModelName, MigrationMapper>;
  readonly oldModels: ModelTable;
  readonly desiredModels: ModelTable;
  readonly oldLocks: OldLockSet;
  readonly inventory: ReadonlyArray<WorkInventoryItem>;
  readonly chunkSize: number;
  readonly clock: ClockPort;
  readonly isExpiredRow?: (row: StoredRow) => boolean;
}

/** Resume outcome: current progress plus the flip when one committed. */
export interface ResumeMigrationResult {
  readonly progress: MigrationProgress | null;
  readonly flip: FlipResult | null;
}

/**
 * Resume (or observe) one migration from its stored progress. No stored
 * progress means nothing to resume (fresh staging starts via
 * `stageNextChunk` directly); `active` is a no-op observation. `staging`
 * advances one chunk per call (callers loop) and validates once the scan
 * exhausts; `staged` re-validates; `publishing` completes the publish
 * loop plus the flip; `failed` demands an operator decision. Unknown
 * phases block, fail closed.
 */
export async function resumeMigration(
  input: ResumeMigrationInput,
): Promise<ResumeMigrationResult> {
  const { store, plan } = input;
  const progress = await store.readMigrationProgress(plan.migrationId);
  if (progress === null) {
    return { progress: null, flip: null };
  }
  switch (progress.phase) {
    case 'staging': {
      const staged = await stageNextChunk({
        store,
        plan,
        mappers: input.mappers,
        oldModels: input.oldModels,
        desiredModels: input.desiredModels,
        chunkSize: input.chunkSize,
        ...(input.isExpiredRow === undefined ? {} : { isExpiredRow: input.isExpiredRow }),
      });
      if (!staged.done) {
        return { progress: staged.progress, flip: null };
      }
      // The chunk completed the scan, so this same resume advances to
      // validation (`stageNextChunk` never auto-advances; resume is the
      // caller that does). Resume-only callers thus reach `staged`
      // without stalling; activation itself stays explicit (`activate`).
      const validated = await validateStaged({
        store,
        plan,
        desiredModels: input.desiredModels,
        oldLocks: input.oldLocks,
        oldModels: input.oldModels,
      });
      return { progress: validated, flip: null };
    }
    case 'staged': {
      // Re-validated, not assumed: an already-validated set revalidates
      // idempotently (same staged rows, same checks, cursor-preserving
      // empty write), so a stale `staged` never sneaks past new evidence.
      const validated = await validateStaged({
        store,
        plan,
        desiredModels: input.desiredModels,
        oldLocks: input.oldLocks,
        oldModels: input.oldModels,
      });
      return { progress: validated, flip: null };
    }
    case 'publishing': {
      const disposition = await checkActivationInventory(store, plan, input.inventory);
      const now = input.clock.nowMs();
      if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) {
        throw new StateError('validation', 'Migration clock must supply a finite time >= 0.');
      }
      const actor = `migration:${plan.toSnapshotId}`;
      await publishStagedAndDrops(
        store,
        plan,
        input.oldModels,
        input.desiredModels,
        input.chunkSize,
        now,
        actor,
      );
      const flip = await flipToInstalled(store, plan, now, disposition);
      const after = await store.readMigrationProgress(plan.migrationId);
      if (after?.phase !== 'active') {
        // Goal-state check (stronger than the flip flag): publish ran and
        // the flip returned, but this migration is not active — the flip
        // no-opped (foreign-installed target) or progress was tampered
        // with. Returning a still-publishing result would livelock the
        // next resume with silently unrecorded skips/outcomes: fail loud.
        throw new StateError(
          'validation',
          `Migration flip committed nothing for ${JSON.stringify(plan.migrationId)}: ` +
            `progress is ${JSON.stringify(after?.phase ?? 'missing')} ` +
            `(another migration owns the installed target?).`,
        );
      }
      return { progress: after, flip };
    }
    case 'active':
      return { progress, flip: null };
    case 'failed':
      throw new StateError(
        'validation',
        'Migration is failed; an operator decision is required before retry.',
      );
    default: {
      const phase = (progress as MigrationProgress).phase;
      throw new StateError('validation', `Unknown migration phase: ${JSON.stringify(phase)}.`);
    }
  }
}
