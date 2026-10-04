/**
 * Lane 03 S7: bounded resumable staging of migration target rows.
 *
 * `stageNextChunk` scans the frozen before-state (admissions are closed by
 * L7, so live reads are stable) in (model, id) order after the stored
 * staging cursor, structurally maps up to `chunkSize` rows, runs backfill
 * mappers where the plan requires them, and commits one fenced staging
 * chunk. It never auto-advances phases: when the scan exhausts, the caller
 * moves to `validateStaged`.
 *
 * Staging cursor space is the SOURCE (old model, record id) space;
 * publish cursors (see `activate`) live in staged-target space instead.
 *
 * Failure taxonomy: data failures are `StateError` validation (fail
 * closed, deterministic); fence contention surfaces as `busy` (retryable)
 * via `storageToStateError`; mapper bugs (non-`StateError` throws)
 * propagate untouched, never staged; a malformed `chunkSize` is a plain
 * `Error` programmer bug, mirroring the adapter limit rule.
 *
 * INTERIM: content expiry has no representation in the interim stack
 * (StoredRow carries no lifetime; L1 owes lifetime descriptors), so the
 * expired-row block rides the optional deployment-supplied `isExpiredRow`
 * predicate until then. Archived rows stage indistinguishably from live
 * rows; their `archivedAt` rides the staged row (contract round-trip), and
 * publish preserves it — staging never unarchives.
 */

import type {
  MigrationProgress,
  ModelName,
  RecordVersion,
  Revision,
  StagedRow,
  StagedRowCursor,
  StoragePort,
  StoredRow,
} from '../../../contracts/src/state.js';
import type { ModelTable } from '../mutation/models.js';
import { StateError, storageToStateError } from '../errors.js';
import {
  createMigrationRowBuilder,
  freezeBeforeRow,
  validateMappedRow,
  type MigrationMapper,
} from './mapper.js';
import type { ValidatedMigrationPlan } from './transition.js';

/** One staging call: store, validated plan, target-keyed mappers, bounds. */
export interface StageNextChunkInput {
  readonly store: StoragePort;
  readonly plan: ValidatedMigrationPlan;
  /** Mappers keyed by TARGET model name (backfill names targets). */
  readonly mappers: ReadonlyMap<ModelName, MigrationMapper>;
  readonly oldModels: ModelTable;
  readonly desiredModels: ModelTable;
  readonly chunkSize: number;
  /**
   * INTERIM expiry evidence (see module note). Rows it flags block
   * staging with validation: expired content cannot be backfilled or
   * resurrected. Absent until L1 lifetime descriptors land.
   */
  readonly isExpiredRow?: (row: StoredRow) => boolean;
}

/** Staging outcome: done when the scan exhausts; progress is current. */
export interface StageNextChunkResult {
  readonly done: boolean;
  readonly progress: MigrationProgress;
}

/** Old models needing staged rows, in deterministic scan order. */
function stagedSources(plan: ValidatedMigrationPlan): string[] {
  const sources: string[] = [];
  for (const [name, mapping] of plan.models) {
    if (mapping.needsStaging && mapping.target !== null) {
      sources.push(name as string);
    }
  }
  return sources.sort();
}

/**
 * Check mapper wiring before scanning (fail fast): every backfill target
 * needs exactly its mapper, and stray mappers block (plan/mapper mismatch
 * is fail closed, never silently ignored).
 */
function checkMapperWiring(
  plan: ValidatedMigrationPlan,
  mappers: ReadonlyMap<ModelName, MigrationMapper>,
): void {
  for (const target of plan.backfills) {
    if (!mappers.has(target)) {
      throw new StateError(
        'validation',
        `Migration has no mapper for backfill model ${JSON.stringify(target as string)}.`,
      );
    }
  }
  for (const target of mappers.keys()) {
    if (!plan.backfills.has(target)) {
      throw new StateError(
        'validation',
        `Migration mapper for non-backfill model ${JSON.stringify(target as string)}.`,
      );
    }
  }
}

/**
 * Stage the next bounded chunk of target rows. Returns `{done: true}` once
 * the scan exhausts (the caller then advances to `validateStaged`); calls
 * past staging completion are idempotent no-ops returning the stored
 * progress.
 */
export async function stageNextChunk(input: StageNextChunkInput): Promise<StageNextChunkResult> {
  const { store, plan, mappers, desiredModels, chunkSize } = input;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`Invalid migration chunk size: ${JSON.stringify(chunkSize)}`);
  }
  const progress = await store.readMigrationProgress(plan.migrationId);
  if (progress !== null && progress.phase === 'failed') {
    throw new StateError(
      'validation',
      'Migration is failed; an operator decision is required before retry.',
    );
  }
  if (progress !== null && progress.phase !== 'staging') {
    return { done: true, progress };
  }
  checkMapperWiring(plan, mappers);

  const sources = stagedSources(plan);
  const cursor = progress?.stagedCursor ?? null;
  const staged: StagedRow[] = [];
  let stagedCursor: StagedRowCursor | null = cursor;
  let remaining = chunkSize;
  let exhausted = true;

  for (const source of sources) {
    if (remaining === 0) {
      // Chunk filled exactly while sources remain unscanned: more may wait.
      exhausted = false;
      break;
    }
    if (cursor !== null && source < cursor.model) {
      continue;
    }
    const resumeId = cursor !== null && source === cursor.model ? cursor.recordId : null;
    // Read-ahead by one: a full page proves more rows wait (precise
    // `done` even when the chunk fills exactly at a source boundary).
    const rows = await store.query({
      model: source as ModelName,
      authority: 'owner',
      archived: 'include',
      ...(resumeId === null
        ? {}
        : { where: { op: 'gt', field: 'id', value: resumeId } }),
      order: [{ field: 'id', direction: 'asc' }],
      limit: remaining + 1,
    });
    if (rows.length > remaining) {
      for (const row of rows.slice(0, remaining)) {
        staged.push(stageOneRow(input, source, row));
        stagedCursor = { model: source, recordId: row.id as string };
      }
      remaining = 0;
      exhausted = false;
      break;
    }
    for (const row of rows) {
      staged.push(stageOneRow(input, source, row));
      stagedCursor = { model: source, recordId: row.id as string };
      remaining -= 1;
    }
  }

  if (staged.length === 0) {
    // Empty scan: establish progress on first touch, else a pure no-op.
    if (progress === null) {
      const revision = await store.readRevision();
      const fresh: MigrationProgress = {
        migrationId: plan.migrationId,
        phase: 'staging',
        stagedCursor: null,
        publishCursor: null,
        updatedRevision: (revision as number + 1) as Revision,
      };
      try {
        await store.stageMigrationRows({
          expectedRevision: revision,
          migrationId: plan.migrationId,
          rows: [],
          progress: fresh,
        });
      } catch (error) {
        throw storageToStateError(error);
      }
      return { done: true, progress: fresh };
    }
    return { done: true, progress };
  }

  const revision = await store.readRevision();
  const next: MigrationProgress = {
    migrationId: plan.migrationId,
    phase: 'staging',
    stagedCursor,
    publishCursor: progress?.publishCursor ?? null,
    updatedRevision: (revision as number + 1) as Revision,
  };
  try {
    await store.stageMigrationRows({
      expectedRevision: revision,
      migrationId: plan.migrationId,
      rows: staged,
      progress: next,
    });
  } catch (error) {
    throw storageToStateError(error);
  }
  return { done: exhausted, progress: next };
}

/**
 * Structurally map one live row to its staged target row, running the
 * backfill mapper when the plan requires one. Drops never reach here
 * (dropped models are not scanned); expired rows block with validation.
 */
function stageOneRow(input: StageNextChunkInput, source: string, row: StoredRow): StagedRow {
  const { plan, mappers, desiredModels, isExpiredRow } = input;
  if (isExpiredRow !== undefined && isExpiredRow(row) === true) {
    throw new StateError(
      'validation',
      `Cannot migrate expired row ${JSON.stringify(source)}/${JSON.stringify(row.id)}: ` +
        `expired content cannot be backfilled or resurrected.`,
    );
  }
  const mapping = plan.models.get(source as ModelName);
  if (mapping === undefined || mapping.target === null) {
    throw new StateError(
      'validation',
      `Migration stages unmapped model ${JSON.stringify(source)}.`,
    );
  }
  const desiredDef = desiredModels.get(mapping.target);
  if (desiredDef === undefined) {
    throw new StateError(
      'validation',
      `Migration plan and desired defs disagree on ${JSON.stringify(mapping.target as string)}.`,
    );
  }
  // Structural mapping: retained values copy as-is (validity is proven by
  // `validateMappedRow`, never assumed); renamed fields move; dropped
  // fields vanish (a field drop is a conversion, not a row drop).
  const seed: Record<string, unknown> = {};
  for (const [field, handling] of mapping.fields) {
    if (handling.kind === 'drop') {
      continue;
    }
    if (!Object.hasOwn(row.data, field)) {
      continue;
    }
    seed[handling.kind === 'rename' ? handling.to : field] = (
      row.data as Readonly<Record<string, unknown>>
    )[field];
  }
  const converted = mapping.needsBackfill || mapping.hasFieldDrops;
  let mapped: Record<string, unknown>;
  if (mapping.needsBackfill) {
    const mapper = mappers.get(mapping.target);
    if (mapper === undefined) {
      throw new StateError(
        'validation',
        `Migration has no mapper for backfill model ${JSON.stringify(mapping.target as string)}.`,
      );
    }
    const before = freezeBeforeRow(row);
    const seeded = createMigrationRowBuilder(seed, desiredDef);
    // No catch: mapper bugs propagate untouched, never staged; builder
    // misuse already throws StateError validation from the builder itself.
    mapper(before, seeded.builder);
    mapped = seeded.build();
  } else {
    mapped = seed;
  }
  validateMappedRow(mapped, desiredDef);
  return {
    targetModel: mapping.target,
    recordId: row.id,
    version: ((row.version as number) + (converted ? 1 : 0)) as RecordVersion,
    data: mapped,
    parent: row.parent ?? null,
    converted,
    // Creation metadata and archive state ride the staged row so publish
    // preserves them through renames (DESIGN §11: protected
    // identity/creation metadata unchanged; archived rows stay archived).
    created: row.created,
    createdBy: row.createdBy,
    archivedAt: row.archivedAt,
  };
}
