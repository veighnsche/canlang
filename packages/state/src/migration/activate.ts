/**
 * Lane 03 S7: migration activation (invalidate, publish, flip).
 *
 * `activate` runs the single-shot path from a `staged` set: it gates on
 * the caller-supplied work inventory (every item undispatched with a
 * pinned handler contract, cross-checked against still-pending outbox
 * intents — anything else blocks with validation), publishes staged rows
 * plus drops in bounded fenced chunks with migration-attributed history,
 * moves unique claims atomically with their rows, and flips the installed
 * snapshot pointer. `resumeMigration` (see `index.ts`) reuses the
 * publish/flip internals to continue an interrupted `publishing` run.
 *
 * Failure taxonomy: precondition/evidence failures are `StateError`
 * validation; fence contention surfaces as `busy` (retryable) via
 * `storageToStateError` (unique-conflict storage errors map to `conflict`
 * the same way); a malformed `chunkSize` is a plain `Error` programmer
 * bug, mirroring the adapter limit rule.
 *
 * History vocabulary (lane decision): conversions get `update` (+1,
 * `migration:<toSnapshotId>` actor), drops get `remove`, name-only rows
 * get nothing. Drop history rides `MigrationDrop.history` only — never
 * duplicated into the chunk `history` array.
 *
 * Unique-claim moves ride each publish chunk (releases + claims applied
 * atomically with rows/history/drops): renames release old-model claims
 * and claim new-model ones, same-model value changes release/claim within
 * the model, removed keys release, added keys claim, and drops release.
 * Releases apply before claims within a chunk, so same-chunk swaps are
 * safe. KNOWN LIMITATION (loud): swap/chain renames preserving identical
 * unique values across a chunk boundary conflict deterministically (a
 * later chunk releases what an earlier chunk claimed) and block with
 * `conflict` until an operator intervenes — there is no topological
 * chunking in this slice. Realistic single renames are unaffected.
 * Flagged for the coordinator.
 *
 * DETERMINISM (loud, verified): conversions always carry history with
 * the frozen engine clock, and publish stamps `updated`/`updatedBy` from
 * those entries — never wall-clock. Name-only rows carry live metadata
 * forward; only rows with no staged, live, or history source fall back
 * to 0/''/null (direct unstaged commits only). History `at` and
 * `installedAt` likewise use the engine clock.
 *
 * CONTRACT GAPS (loud):
 * - The flip's `installedRevision` input is unknowable pre-commit, so the
 *   engine passes `0` and adapters OVERWRITE it with the actual flip
 *   revision (contract-pinned); `installedAt` is honored from input.
 */

import type {
  FlipInstalledSnapshot,
  FlipResult,
  HistoryEntry,
  MigrationDrop,
  MigrationOutcome,
  ModelName,
  OperationId,
  OperationName,
  Revision,
  StagedRow,
  StoragePort,
  StoredRow,
  UniqueClaim,
  UniqueRelease,
  WorkInventoryItem,
} from '../../../contracts/src/state.js';
import type { ClockPort } from '../invocation/context.js';
import type { ModelTable } from '../mutation/models.js';
import { StateError, storageToStateError } from '../errors.js';
import { canonicalUniqueValue } from './validate.js';
import type { ValidatedMigrationPlan } from './transition.js';

/** One activation call: store, plan, inventory, tables, bounds, clock. */
export interface ActivateInput {
  readonly store: StoragePort;
  readonly plan: ValidatedMigrationPlan;
  readonly inventory: ReadonlyArray<WorkInventoryItem>;
  readonly oldModels: ModelTable;
  readonly desiredModels: ModelTable;
  readonly chunkSize: number;
  readonly clock: ClockPort;
}

/** Invalidate disposition: intent ids to skip plus their outcome records. */
export interface ActivationDisposition {
  readonly invalidatedIntentIds: ReadonlyArray<string>;
  readonly outcomes: ReadonlyArray<MigrationOutcome>;
}

/** Dropped-model live rows enumerated for one publish chunk. */
interface DropCandidate {
  readonly model: string;
  readonly row: StoredRow;
}

/**
 * Single-shot activation from a `staged` set: inventory gate, publish
 * loop, flip. Strict precondition — `publishing` runs continue through
 * `resumeMigration`, never by re-entering here.
 */
export async function activate(input: ActivateInput): Promise<FlipResult> {
  const { store, plan, inventory, oldModels, desiredModels, chunkSize, clock } = input;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`Invalid migration chunk size: ${JSON.stringify(chunkSize)}`);
  }
  const progress = await store.readMigrationProgress(plan.migrationId);
  if (progress === null) {
    throw new StateError('validation', 'Migration has no staged state to activate.');
  }
  if (progress.phase !== 'staged') {
    if (progress.phase === 'failed') {
      throw new StateError(
        'validation',
        'Migration is failed; an operator decision is required before retry.',
      );
    }
    throw new StateError(
      'validation',
      `Migration activation needs a staged set; progress is ${progress.phase}.`,
    );
  }
  checkTableAgreement(plan, oldModels, desiredModels);
  const disposition = await checkActivationInventory(store, plan, inventory);
  const now = clock.nowMs();
  if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) {
    throw new StateError('validation', 'Migration clock must supply a finite time >= 0.');
  }
  const actor = `migration:${plan.toSnapshotId}`;
  await publishStagedAndDrops(store, plan, oldModels, desiredModels, chunkSize, now, actor);
  return flipToInstalled(store, plan, now, disposition);
}

/** Fail closed when callers pass tables the plan was not validated against. */
function checkTableAgreement(
  plan: ValidatedMigrationPlan,
  oldModels: ModelTable,
  desiredModels: ModelTable,
): void {
  for (const name of plan.models.keys()) {
    if (!oldModels.has(name)) {
      throw new StateError(
        'validation',
        `Migration plan and old defs disagree on ${JSON.stringify(name as string)}.`,
      );
    }
  }
  for (const target of plan.targets.keys()) {
    if (!desiredModels.has(target)) {
      throw new StateError(
        'validation',
        `Migration plan and desired defs disagree on ${JSON.stringify(target as string)}.`,
      );
    }
  }
  for (const name of plan.newModels) {
    if (!desiredModels.has(name)) {
      throw new StateError(
        'validation',
        `Migration plan and desired defs disagree on ${JSON.stringify(name as string)}.`,
      );
    }
  }
}

/**
 * Inventory gate (shared by `activate` and `resumeMigration`): `invalidate`
 * disposes ONLY undispatched items whose handler contract is pinned by a
 * directive. In-flight/accepted/uncertain items block (drain/reconcile is
 * L7's job), unpinned undispatched items block (no disposition), and
 * pinned ids no longer pending in the outbox block (evidence changed
 * under us; missing evidence blocks).
 */
export async function checkActivationInventory(
  store: StoragePort,
  plan: ValidatedMigrationPlan,
  inventory: ReadonlyArray<WorkInventoryItem>,
): Promise<ActivationDisposition> {
  if (!Array.isArray(inventory)) {
    throw new StateError('validation', 'Migration inventory must be an array.');
  }
  const pinned = new Set(plan.invalidates);
  const blocked: string[] = [];
  const unpinned: string[] = [];
  const invalidated: Array<{ intentId: string; handlerContract: string }> = [];
  const seen = new Set<string>();
  for (const item of inventory) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new StateError('validation', 'Migration inventory items must be objects.');
    }
    const intentId = item.intentId;
    const handlerContract = item.handlerContract;
    const state = item.state;
    if (typeof intentId !== 'string' || intentId === '') {
      throw new StateError('validation', 'Migration inventory intent ids must be non-empty.');
    }
    if (typeof handlerContract !== 'string' || handlerContract === '') {
      throw new StateError('validation', 'Migration inventory handler contracts must be non-empty.');
    }
    if (state !== 'undispatched' && state !== 'inflight' && state !== 'accepted' && state !== 'uncertain') {
      throw new StateError(
        'validation',
        `Migration inventory item ${JSON.stringify(intentId)} has unknown state.`,
      );
    }
    if (state !== 'undispatched') {
      blocked.push(intentId);
      continue;
    }
    if (!pinned.has(handlerContract)) {
      unpinned.push(intentId);
      continue;
    }
    if (!seen.has(intentId)) {
      seen.add(intentId);
      invalidated.push({ intentId, handlerContract });
    }
  }
  if (blocked.length > 0) {
    blocked.sort();
    throw new StateError(
      'validation',
      `Migration cannot invalidate in-flight, accepted, or uncertain work ` +
        `(drain/reconcile first): ${blocked.map((id) => JSON.stringify(id)).join(', ')}.`,
    );
  }
  if (unpinned.length > 0) {
    unpinned.sort();
    throw new StateError(
      'validation',
      `Migration inventory has undispatched work with no pinned invalidate contract ` +
        `(no disposition): ${unpinned.map((id) => JSON.stringify(id)).join(', ')}.`,
    );
  }
  if (invalidated.length > 0) {
    const pending = await store.outboxPending();
    const pendingIds = new Set(pending.map((intent) => intent.intentId));
    const missing = invalidated
      .map((entry) => entry.intentId)
      .filter((id) => !pendingIds.has(id))
      .sort();
    if (missing.length > 0) {
      throw new StateError(
        'validation',
        `Migration invalidate evidence changed under us (not pending): ` +
          `${missing.map((id) => JSON.stringify(id)).join(', ')}.`,
      );
    }
  }
  return {
    invalidatedIntentIds: invalidated.map((entry) => entry.intentId),
    outcomes: invalidated.map((entry) => ({
      migrationId: plan.migrationId,
      kind: 'invalidated',
      intentId: entry.intentId,
      handlerContract: entry.handlerContract,
    })),
  };
}

/**
 * Publish loop (shared by `activate` and `resumeMigration`): bounded
 * staged reads after the publish cursor plus bounded drop enumeration per
 * chunk until both exhaust. Drop enumeration is state-derived (disposed
 * rows vanish), so an interrupted loop resumes without a drop cursor and
 * never republishes a cursor range.
 */
export async function publishStagedAndDrops(
  store: StoragePort,
  plan: ValidatedMigrationPlan,
  oldModels: ModelTable,
  desiredModels: ModelTable,
  chunkSize: number,
  now: number,
  actor: string,
): Promise<void> {
  if (plan.ownerAction.kind === 'drop') {
    // Fail fast BEFORE disposing anything: a removal flip against an
    // absent pointer would no-op success while silently dropping its
    // skips/outcomes, so missing stored evidence blocks up front (the
    // flip re-checks against concurrent removal; see flipToInstalled).
    if ((await store.readInstalledSnapshot(plan.owner)) === null) {
      throw new StateError(
        'validation',
        `Migration cannot remove owner ${JSON.stringify(plan.owner)}: ` +
          `no installed snapshot pointer (missing predecessor evidence).`,
      );
    }
  }
  for (;;) {
    const progress = await store.readMigrationProgress(plan.migrationId);
    if (progress === null) {
      throw new StateError('validation', 'Migration has no staged state to publish.');
    }
    if (progress.phase !== 'staged' && progress.phase !== 'publishing') {
      throw new StateError(
        'validation',
        `Migration publish needs a staged or publishing set; progress is ${progress.phase}.`,
      );
    }
    const staged = await store.readStagedRows(plan.migrationId, progress.publishCursor, chunkSize);
    const drops = await enumerateDrops(store, plan, chunkSize);
    if (staged.length === 0 && drops.length === 0) {
      return;
    }
    const history: HistoryEntry[] = [];
    const dropEntries: MigrationDrop[] = [];
    const uniqueClaims: UniqueClaim[] = [];
    const uniqueReleases: UniqueRelease[] = [];
    for (const row of staged) {
      await appendStagedPublish(
        store,
        plan,
        oldModels,
        desiredModels,
        row,
        now,
        actor,
        history,
        dropEntries,
        uniqueClaims,
        uniqueReleases,
      );
    }
    for (const drop of drops) {
      appendDropPublish(plan, oldModels, drop, now, actor, dropEntries, uniqueReleases);
    }
    const revision = await store.readRevision();
    const last = staged[staged.length - 1];
    const next = {
      migrationId: plan.migrationId,
      phase: 'publishing',
      stagedCursor: progress.stagedCursor,
      publishCursor:
        last === undefined
          ? progress.publishCursor
          : {
              model: last.targetModel as string,
              recordId: last.recordId as string,
            },
      updatedRevision: (revision as number + 1) as Revision,
    } as const;
    try {
      await store.publishMigrationChunk({
        expectedRevision: revision,
        migrationId: plan.migrationId,
        rows: staged,
        history,
        drops: dropEntries,
        progress: next,
        uniqueClaims,
        uniqueReleases,
      });
    } catch (error) {
      throw storageToStateError(error);
    }
  }
}

/**
 * Build one staged row's publish inputs: conversion history (`update`,
 * before = last live shape) plus unique-claim moves derived from the old
 * values (live) and new values (staged). Name-only rows publish silently.
 * Renamed rows additionally dispose their source row in the SAME chunk
 * (a rename is a move, not a copy): the source gets a `remove` entry
 * while the target carries the conversion, so neither side orphans.
 * Rename disposal is NOT drop-gated (locks/refs): the row survives under
 * its new name, refs follow through desired defs, and mapped-lock
 * validity was proven at validation — only true drops gate.
 */
async function appendStagedPublish(
  store: StoragePort,
  plan: ValidatedMigrationPlan,
  oldModels: ModelTable,
  desiredModels: ModelTable,
  row: StagedRow,
  now: number,
  actor: string,
  history: HistoryEntry[],
  dropEntries: MigrationDrop[],
  uniqueClaims: UniqueClaim[],
  uniqueReleases: UniqueRelease[],
): Promise<void> {
  const target = row.targetModel as string;
  const source = plan.targets.get(row.targetModel);
  if (source === undefined) {
    throw new StateError(
      'validation',
      `Migration staged a row for sourceless target ${JSON.stringify(target)}.`,
    );
  }
  const oldDef = oldModels.get(source);
  const desiredDef = desiredModels.get(row.targetModel);
  if (oldDef === undefined || desiredDef === undefined) {
    throw new StateError(
      'validation',
      `Migration plan and model defs disagree on ${JSON.stringify(target)}.`,
    );
  }
  // INTERIM: migration identity is not an operation, but history entries
  // are operation-typed; the migration id rides both fields (cast) until
  // L7 defines migration operation naming.
  const operation = plan.migrationId as unknown as OperationName;
  const operationId = plan.migrationId as unknown as OperationId;
  const live = await store.load(source, row.recordId);
  if (live === null) {
    throw new StateError(
      'validation',
      `Migration publish lost the live source for ${JSON.stringify(target)}/` +
        `${JSON.stringify(row.recordId)} (evidence changed under us).`,
    );
  }
  if (row.converted) {
    history.push({
      model: row.targetModel,
      recordId: row.recordId,
      version: row.version,
      operation,
      operationId,
      actor,
      at: now,
      change: 'update',
      before: live.data,
      after: row.data,
    });
  }
  const renamed = (source as string) !== target;
  if (renamed) {
    // The move's source side: disposed as-is (no version advance — the
    // target version already records the conversion), with a `remove`
    // entry chaining the audit trail (pre-rename history stays queryable
    // under the source model name; it is never rewritten onto the target).
    dropEntries.push({
      model: source,
      recordId: row.recordId,
      version: live.version,
      history: {
        model: source,
        recordId: row.recordId,
        version: live.version,
        operation,
        operationId,
        actor,
        at: now,
        change: 'remove',
        before: live.data,
        after: null,
      },
    });
  }
  const liveData = live.data as Readonly<Record<string, unknown>>;
  const stagedData = row.data;
  for (const key of oldDef.uniqueKeys) {
    const oldValue = canonicalUniqueValue(
      Object.hasOwn(liveData, key) ? liveData[key] : undefined,
      key,
      source as string,
    );
    if (oldValue === null) {
      continue;
    }
    const newRaw = Object.hasOwn(stagedData, key) ? stagedData[key] : undefined;
    const sameKey =
      Object.hasOwn(desiredDef.fields, key) &&
      desiredDef.uniqueKeys.includes(key) &&
      canonicalUniqueValue(newRaw, key, target) === oldValue;
    if (renamed || !sameKey) {
      uniqueReleases.push({ model: source, keyName: key, keyValue: oldValue });
    }
  }
  for (const key of desiredDef.uniqueKeys) {
    const newValue = canonicalUniqueValue(
      Object.hasOwn(stagedData, key) ? stagedData[key] : undefined,
      key,
      target,
    );
    if (newValue === null) {
      continue;
    }
    const oldRaw = Object.hasOwn(liveData, key) ? liveData[key] : undefined;
    const sameKey =
      Object.hasOwn(oldDef.fields, key) &&
      oldDef.uniqueKeys.includes(key) &&
      canonicalUniqueValue(oldRaw, key, source as string) === newValue;
    if (renamed || !sameKey) {
      uniqueClaims.push({ model: row.targetModel, keyName: key, keyValue: newValue, recordId: row.recordId });
    }
  }
}

/**
 * Build one drop's publish inputs: the `remove` entry (before = last live
 * shape, after null) riding the drop itself, plus releases for the
 * dropped row's claimed keys so the unique index never leaks.
 */
function appendDropPublish(
  plan: ValidatedMigrationPlan,
  oldModels: ModelTable,
  drop: DropCandidate,
  now: number,
  actor: string,
  dropEntries: MigrationDrop[],
  uniqueReleases: UniqueRelease[],
): void {
  const oldDef = oldModels.get(drop.model as ModelName);
  if (oldDef === undefined) {
    throw new StateError(
      'validation',
      `Migration plan and old defs disagree on ${JSON.stringify(drop.model)}.`,
    );
  }
  const operation = plan.migrationId as unknown as OperationName;
  const operationId = plan.migrationId as unknown as OperationId;
  const liveData = drop.row.data as Readonly<Record<string, unknown>>;
  dropEntries.push({
    model: drop.model as ModelName,
    recordId: drop.row.id,
    version: drop.row.version,
    history: {
      model: drop.model as ModelName,
      recordId: drop.row.id,
      version: drop.row.version,
      operation,
      operationId,
      actor,
      at: now,
      change: 'remove',
      before: liveData,
      after: null,
    },
  });
  for (const key of oldDef.uniqueKeys) {
    const value = canonicalUniqueValue(
      Object.hasOwn(liveData, key) ? liveData[key] : undefined,
      key,
      drop.model,
    );
    if (value !== null) {
      uniqueReleases.push({ model: drop.model as ModelName, keyName: key, keyValue: value });
    }
  }
}

/**
 * Enumerate undisposed live rows of dropped models (bounded per chunk,
 * deterministic model/id order). Only `dropModel`/`dropOwner` produce
 * row drops — dropped FIELDS are conversions staged as data without the
 * field, never row disposals.
 */
async function enumerateDrops(
  store: StoragePort,
  plan: ValidatedMigrationPlan,
  budget: number,
): Promise<DropCandidate[]> {
  const dropped: string[] = [];
  for (const [name, mapping] of plan.models) {
    if (mapping.kind === 'drop') {
      dropped.push(name as string);
    }
  }
  dropped.sort();
  const candidates: DropCandidate[] = [];
  let remaining = budget;
  for (const model of dropped) {
    if (remaining === 0) {
      break;
    }
    const rows = await store.query({
      model: model as ModelName,
      authority: 'owner',
      archived: 'include',
      order: [{ field: 'id', direction: 'asc' }],
      limit: remaining,
    });
    for (const row of rows) {
      if (remaining === 0) {
        break;
      }
      candidates.push({ model, row });
      remaining -= 1;
    }
  }
  return candidates;
}

/**
 * Final fenced flip (shared by `activate` and `resumeMigration`):
 * install the new snapshot pointer (removing the renamed-away owner
 * pointer when present), mark invalidated intents skipped, record
 * outcomes, mark progress active. Idempotent: an already-installed target
 * returns the current revision with `flipped: false`.
 */
export async function flipToInstalled(
  store: StoragePort,
  plan: ValidatedMigrationPlan,
  now: number,
  disposition: ActivationDisposition,
): Promise<FlipResult> {
  const revision = await store.readRevision();
  const dropping = plan.ownerAction.kind === 'drop';
  if (dropping && (await store.readInstalledSnapshot(plan.owner)) === null) {
    // A removal flip against an absent pointer would no-op success while
    // silently dropping its skips/outcomes, so missing stored evidence
    // blocks instead (DESIGN §11.1: missing predecessor evidence blocks).
    // Retries never reach here: a committed removal marks progress
    // active, and resume observes active without re-flipping.
    throw new StateError(
      'validation',
      `Migration cannot remove owner ${JSON.stringify(plan.owner)}: ` +
        `no installed snapshot pointer (missing predecessor evidence).`,
    );
  }
  const input: FlipInstalledSnapshot = {
    expectedRevision: revision,
    migrationId: plan.migrationId,
    owner: plan.owner,
    // dropOwner removes the pointer (removal flip); anything else installs.
    snapshot: dropping
      ? null
      : {
          owner: plan.owner,
          snapshotId: plan.toSnapshotId,
          digest: plan.toDigest,
          // INTERIM PLACEHOLDER (loud, contract-pinned): the flip's commit
          // revision is unknowable pre-commit, so adapters OVERWRITE this
          // field with the actual flip revision; `installedAt` below is
          // honored from the engine clock.
          installedRevision: 0 as Revision,
          installedAt: now,
        },
    renameFromOwner: plan.ownerAction.kind === 'rename' ? plan.ownerAction.from : null,
    invalidatedIntentIds: disposition.invalidatedIntentIds,
    outcomes: disposition.outcomes,
  };
  try {
    return await store.flipInstalledSnapshot(input);
  } catch (error) {
    throw storageToStateError(error);
  }
}
