/**
 * Lane 03 S7: complete-staged-set validation before activation.
 *
 * `validateStaged` re-reads the full staged set through bounded scans and
 * proves it is a valid post-state: every staged row validates under its
 * desired def, invariants hold over the staged-plus-retained-live view,
 * uniqueness holds within each staged set (plus desired-key checks over
 * retained-live rows, which matter for constraint-only changes), staged
 * references resolve to post-state rows (model retention first, then id
 * existence against the staged-plus-retained-live view, never a live
 * dereference beyond the validation scans), originally-protected
 * retained rows still satisfy their MAPPED old-lock predicates after
 * backfill, and the staged set is complete (every live row of every
 * staged model has a staged row; dropped models need none). Success
 * records phase `staged` via an EMPTY
 * `stageMigrationRows` chunk (rows `[]` — the contract upserts progress
 * with no rows); any failure throws validation and the phase stays
 * `staging`, so resume restages.
 *
 * Failure taxonomy: every check failure is `StateError` validation.
 * Invariant bugs (non-`StateError` throws) propagate untouched, mirroring
 * the mapper-bug contract; invariant `StateError`s rethrow as validation.
 * Fence contention on the phase write surfaces as `busy` (retryable).
 *
 * INTERIM notes:
 * - Reference scope/authority ("same protected scope/authority") has no
 *   representation in the interim stack (L1 owes scope descriptors), so
 *   the model-identity check (target retained/renamed, never dropped or
 *   new-empty) stands in; per-owner transitions keep all rows same-owner.
 * - Drop gating (DESIGN §11.2 "drops remain subject to locks, incoming
 *   references"): true drops (dropModel/dropOwner) of locked rows or rows
 *   with live incoming refs block with validation. Referrers that are
 *   themselves dropped are masked (both vanish); staged referrers are
 *   judged by their STAGED data (kept ref blocks, removed ref masks).
 *   Rename disposals are moves, not drops — ungated (see activate.ts).
 * - Lock/invariant evaluation synthesizes post-state rows with LIVE
 *   `updated`/`updatedBy`: publish stamps conversions from their history
 *   entries (engine clock, deterministic — every conversion carries one),
 *   but validation runs before history exists, so locks predicating on
 *   `updated` evaluate against a pre-stamp approximation. No wall-clock
 *   enters the merge path (adapter fallbacks are deterministic); locks on
 *   mutation timestamps are pathological and stay approximate.
 */

import type {
  MigrationProgress,
  ModelName,
  QueryPredicate,
  RecordId,
  Revision,
  StagedRow,
  StagedRowCursor,
  StoragePort,
  StoredRow,
} from '../../../contracts/src/state.js';
import type { InterimLock, InterimModelDef, ModelTable } from '../mutation/models.js';
import { collectPredicateFields, evalPredicateForRow } from '../policy/grants.js';
import { StateError, storageToStateError } from '../errors.js';
import { validateMappedRow } from './mapper.js';
import type { ValidatedMigrationPlan } from './transition.js';

/** Old-lock evidence for validation, keyed by OLD model name. */
export type OldLockSet = ReadonlyMap<ModelName, ReadonlyArray<InterimLock>>;

/** One validation call: store, validated plan, desired defs, old locks, old models. */
export interface ValidateStagedInput {
  readonly store: StoragePort;
  readonly plan: ValidatedMigrationPlan;
  readonly desiredModels: ModelTable;
  readonly oldLocks: OldLockSet;
  /**
   * Old model defs (locks + refs) for drop gating: drops remain subject
   * to old locks and incoming references (DESIGN §11.2), evaluated here
   * at validation time — before activation, never mid-publish.
   */
  readonly oldModels: ModelTable;
}

/** Internal bound for staged/live validation scans (chunked, unbounded total). */
const VALIDATE_SCAN_LIMIT = 500;

/** Full staged-row scan in (target model, record id) order. */
async function scanAllStaged(
  store: StoragePort,
  migrationId: string,
): Promise<StagedRow[]> {
  const rows: StagedRow[] = [];
  let cursor: StagedRowCursor | null = null;
  for (;;) {
    const chunk = await store.readStagedRows(migrationId, cursor, VALIDATE_SCAN_LIMIT);
    if (chunk.length === 0) {
      return rows;
    }
    rows.push(...chunk);
    const last = chunk[chunk.length - 1];
    if (last === undefined || chunk.length < VALIDATE_SCAN_LIMIT) {
      return rows;
    }
    cursor = { model: last.targetModel as string, recordId: last.recordId as string };
  }
}

/** Full live-model scan in id order, archived included. */
async function scanAllLive(store: StoragePort, model: string): Promise<StoredRow[]> {
  const rows: StoredRow[] = [];
  let after: string | null = null;
  for (;;) {
    const chunk = await store.query({
      model: model as ModelName,
      authority: 'owner',
      archived: 'include',
      ...(after === null ? {} : { where: { op: 'gt', field: 'id', value: after } }),
      order: [{ field: 'id', direction: 'asc' }],
      limit: VALIDATE_SCAN_LIMIT,
    });
    if (chunk.length === 0) {
      return rows;
    }
    rows.push(...chunk);
    const last = chunk[chunk.length - 1];
    if (last === undefined || chunk.length < VALIDATE_SCAN_LIMIT) {
      return rows;
    }
    after = last.id as string;
  }
}

/**
 * Unique-key canonicalization, mirroring the mutation pipeline exactly:
 * strings as-is; numbers/booleans/bigints via `String()`; null/undefined
 * claim nothing; anything else is a caller error, never a silent skip.
 */
export function canonicalUniqueValue(value: unknown, key: string, model: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  throw new StateError(
    'validation',
    `Unique field ${JSON.stringify(key)} on model ${JSON.stringify(model)} ` +
      `must be a scalar value.`,
  );
}

/**
 * Data-only dot-path read (arrays are opaque leaves), mirroring the
 * pipeline's `getDataPath`. Missing or untraversable paths yield
 * `undefined`; explicit `null` leaves return `null`.
 */
function getDataPath(data: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = data;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    const obj = current as Readonly<Record<string, unknown>>;
    if (!Object.hasOwn(obj, segment)) {
      return undefined;
    }
    current = obj[segment];
  }
  return current;
}

/** Row-metadata head segments, which lock mapping leaves untouched. */
const LOCK_METADATA_HEADS: ReadonlySet<string> = new Set([
  'id',
  'version',
  'created',
  'updated',
  'createdBy',
  'updatedBy',
  'archivedAt',
]);

/**
 * Map an old-lock predicate through the validated field mapping: the head
 * segment of each field path follows renames, retained heads stay, and
 * dropped heads are collected (removing still-locked evidence fails).
 */
function mapLockPredicate(
  predicate: QueryPredicate,
  headTarget: (head: string) => string | null,
): { readonly mapped: QueryPredicate; readonly dropped: string[] } {
  const dropped: string[] = [];
  const mapPath = (path: string): string => {
    const dot = path.indexOf('.');
    const head = dot === -1 ? path : path.slice(0, dot);
    const rest = dot === -1 ? '' : path.slice(dot);
    if (LOCK_METADATA_HEADS.has(head)) {
      return path;
    }
    const target = headTarget(head);
    if (target === null) {
      dropped.push(path);
      return path;
    }
    return `${target}${rest}`;
  };
  const visit = (node: QueryPredicate): QueryPredicate => {
    switch (node.op) {
      case 'and':
      case 'or':
        return { op: node.op, args: node.args.map(visit) };
      case 'not':
        return { op: node.op, arg: visit(node.arg) };
      case 'eq':
      case 'ne':
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte':
        return { op: node.op, field: mapPath(node.field), value: node.value };
      case 'between':
        return { op: node.op, field: mapPath(node.field), lo: node.lo, hi: node.hi };
      case 'is_null':
      case 'not_null':
        return { op: node.op, field: mapPath(node.field) };
      default: {
        const op = (node as QueryPredicate).op;
        throw new StateError('validation', `Unknown query predicate: ${JSON.stringify(op)}.`);
      }
    }
  };
  return { mapped: visit(predicate), dropped };
}

/**
 * Validate the complete staged set, recording phase `staged` on success.
 * Re-running over an already-staged set re-validates (idempotent success
 * path); publishing/active sets reject (activation already underway).
 */
export async function validateStaged(input: ValidateStagedInput): Promise<MigrationProgress> {
  const { store, plan, desiredModels, oldLocks, oldModels } = input;
  const progress = await store.readMigrationProgress(plan.migrationId);
  if (progress === null) {
    throw new StateError('validation', 'Migration has no staged state to validate.');
  }
  if (progress.phase === 'failed') {
    throw new StateError(
      'validation',
      'Migration is failed; an operator decision is required before retry.',
    );
  }
  if (progress.phase === 'publishing' || progress.phase === 'active') {
    throw new StateError(
      'validation',
      `Migration is already ${progress.phase}; staged validation is closed.`,
    );
  }

  const staged = await scanAllStaged(store, plan.migrationId);
  const stagedByTarget = new Map<string, StagedRow[]>();
  for (const row of staged) {
    const target = row.targetModel as string;
    if (!plan.targets.has(row.targetModel)) {
      throw new StateError(
        'validation',
        `Migration staged a row for unmapped target ${JSON.stringify(target)}.`,
      );
    }
    const desiredDef = desiredModels.get(row.targetModel);
    if (desiredDef === undefined) {
      throw new StateError(
        'validation',
        `Migration plan and desired defs disagree on ${JSON.stringify(target)}.`,
      );
    }
    validateMappedRow(row.data, desiredDef);
    let bucket = stagedByTarget.get(target);
    if (bucket === undefined) {
      bucket = [];
      stagedByTarget.set(target, bucket);
    }
    bucket.push(row);
  }

  // Completeness: every live row of every staged model has a staged row
  // (id-set comparison via bounded scans — stronger than counts).
  // Dropped models need no staged rows; pure retains persist live.
  const liveBySource = new Map<string, StoredRow[]>();
  for (const [name, mapping] of plan.models) {
    const source = name as string;
    if (!mapping.needsStaging || mapping.target === null) {
      continue;
    }
    const live = await scanAllLive(store, source);
    liveBySource.set(source, live);
    const target = mapping.target as string;
    const stagedIds = new Set(
      (stagedByTarget.get(target) ?? []).map((row) => row.recordId as string),
    );
    const liveIds = new Set(live.map((row) => row.id as string));
    if (stagedIds.size !== liveIds.size) {
      throw new StateError(
        'validation',
        `Migration staged set for ${JSON.stringify(target)} is incomplete: ` +
          `${stagedIds.size} staged rows for ${liveIds.size} live rows.`,
      );
    }
    for (const id of liveIds) {
      if (!stagedIds.has(id)) {
        throw new StateError(
          'validation',
          `Migration staged set for ${JSON.stringify(target)} misses live row ` +
            `${JSON.stringify(id)}.`,
        );
      }
    }
  }

  // Drop gating runs after completeness (the staged index it consults
  // is total from here on) and before every other post-state check, so a
  // blocked drop reports the drop — not a downstream dangling reference.
  await checkDropGating(store, plan, oldModels, stagedByTarget);

  // Uniqueness within each staged set, plus desired-key checks over
  // retained-live rows (constraint-only changes gate untouched models).
  for (const [target, rows] of stagedByTarget) {
    const desiredDef = desiredModels.get(target as ModelName) as InterimModelDef;
    checkUniqueSet(
      rows.map((row) => row.data),
      desiredDef,
      `staged set for ${JSON.stringify(target)}`,
    );
  }
  for (const [name, mapping] of plan.models) {
    const source = name as string;
    if (mapping.kind !== 'retain' || mapping.needsStaging || mapping.target === null) {
      continue;
    }
    const desiredDef = desiredModels.get(mapping.target);
    if (desiredDef === undefined || desiredDef.uniqueKeys.length === 0) {
      continue;
    }
    const live = await scanAllLive(store, source);
    checkUniqueSet(
      live.map((row) => row.data),
      desiredDef,
      `retained live rows for ${JSON.stringify(source)}`,
    );
  }

  // References resolve to retained/renamed targets: opaque id + model
  // check, never dereferenced. Present values must be `{ id }` (mirroring
  // the pipeline: missing skips, null fails); targets must be staged or
  // retained-live — never dropped, never new-empty.
  for (const row of staged) {
    const desiredDef = desiredModels.get(row.targetModel) as InterimModelDef;
    for (const ref of desiredDef.refs) {
      const value = getDataPath(row.data, ref.field);
      if (value === undefined) {
        continue;
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new StateError(
          'validation',
          `Invalid reference in field ${JSON.stringify(ref.field)}.`,
        );
      }
      const targetId = (value as Readonly<Record<string, unknown>>)['id'];
      if (typeof targetId !== 'string' || targetId === '') {
        throw new StateError(
          'validation',
          `Invalid reference in field ${JSON.stringify(ref.field)}.`,
        );
      }
      checkRefTargetRetained(plan, ref.model as string, ref.field);
    }
  }

  // Live metadata for post-state synthesis (keyed by source model + id).
  const liveIndex = new Map<string, StoredRow>();
  for (const [source, rows] of liveBySource) {
    for (const row of rows) {
      liveIndex.set(`${source}\0${row.id as string}`, row);
    }
  }
  const liveFor = (source: string, id: string): StoredRow => {
    const live = liveIndex.get(`${source}\0${id}`);
    if (live === undefined) {
      throw new StateError(
        'validation',
        `Migration staged row ${JSON.stringify(id)} has no live source.`,
      );
    }
    return live;
  };
  const synthesize = (source: string, row: StagedRow): StoredRow => {
    const live = liveFor(source, row.recordId as string);
    return {
      ...live,
      version: row.version,
      parent: row.parent,
      data: row.data,
    };
  };

  // Old locks: every originally-protected retained row still satisfies its
  // MAPPED predicate after backfill. The live match gates the check (rows
  // never protected may stay unlocked or newly lock); mapped evaluation
  // failure — or a lock over removed evidence — blocks with validation.
  for (const [name, mapping] of plan.models) {
    const source = name as string;
    if (mapping.target === null) {
      continue;
    }
    const locks = oldLocks.get(name) ?? [];
    if (locks.length === 0) {
      continue;
    }
    const target = mapping.target as string;
    const headTarget = (head: string): string | null => {
      const handling = mapping.fields.get(head);
      if (handling === undefined || handling.kind === 'retain') {
        return head;
      }
      if (handling.kind === 'rename') {
        return handling.to;
      }
      return null;
    };
    for (const row of stagedByTarget.get(target) ?? []) {
      const live = liveFor(source, row.recordId as string);
      const stagedRow = synthesize(source, row);
      for (const lock of locks) {
        if (!evalPredicateForRow(lock.when, live)) {
          continue;
        }
        const { mapped, dropped } = mapLockPredicate(lock.when, headTarget);
        if (dropped.length > 0) {
          throw new StateError(
            'validation',
            `Migration removes still-locked evidence for lock ${JSON.stringify(lock.name)} ` +
              `on model ${JSON.stringify(source)}.`,
          );
        }
        if (!evalPredicateForRow(mapped, stagedRow)) {
          throw new StateError(
            'validation',
            `Migration backfill unlocks protected row ${JSON.stringify(row.recordId)} under ` +
              `lock ${JSON.stringify(lock.name)} on model ${JSON.stringify(source)}.`,
          );
        }
      }
    }
  }

  // Desired locks: newly locked fields may establish during initialization,
  // then their desired locks apply. Establishment is allowed, never a
  // failure — locks gate future writes (evaluated on pre-state), and this
  // authorized maintenance is the write that establishes them. This pass
  // still evaluates every desired lock over every staged row so malformed
  // predicates fail closed here instead of at first post-migration write.
  for (const row of staged) {
    const desiredDef = desiredModels.get(row.targetModel) as InterimModelDef;
    if (desiredDef.locks.length === 0) {
      continue;
    }
    const source = plan.targets.get(row.targetModel) as ModelName | undefined;
    if (source === undefined) {
      throw new StateError(
        'validation',
        `Migration staged a row for sourceless target ${JSON.stringify(row.targetModel as string)}.`,
      );
    }
    const stagedRow = synthesize(source as string, row);
    for (const lock of desiredDef.locks) {
      evalPredicateForRow(lock.when, stagedRow);
    }
  }

  // Invariants hold over the complete post-state view: staged-derived
  // rows for staged models, live rows for pure retains, nothing for
  // new/dropped models.
  const viewRows = new Map<string, StoredRow>();
  for (const row of staged) {
    const source = plan.targets.get(row.targetModel) as ModelName | undefined;
    if (source === undefined) {
      throw new StateError(
        'validation',
        `Migration staged a row for sourceless target ${JSON.stringify(row.targetModel as string)}.`,
      );
    }
    viewRows.set(
      `${row.targetModel as string}\0${row.recordId as string}`,
      synthesize(source as string, row),
    );
  }
  for (const [name, mapping] of plan.models) {
    const source = name as string;
    if (mapping.kind !== 'retain' || mapping.needsStaging || mapping.target === null) {
      continue;
    }
    for (const row of await scanAllLive(store, source)) {
      viewRows.set(`${mapping.target as string}\0${row.id as string}`, row);
    }
  }
  // Untouched desired models persist live: a desired name with no plan
  // mapping at all (other owners' models under shared-authority tables;
  // genuinely new models scan empty) reads from live, so refs and
  // invariants see the true post-state. Mapped names are already covered
  // (staged/retained) or post-state empty (renamed-away sources).
  for (const desiredName of desiredModels.keys()) {
    if (plan.targets.has(desiredName) || plan.models.has(desiredName)) {
      continue;
    }
    for (const row of await scanAllLive(store, desiredName as string)) {
      viewRows.set(`${desiredName as string}\0${row.id as string}`, row);
    }
  }
  const view = {
    get(model: ModelName, id: RecordId): StoredRow | null {
      return viewRows.get(`${model as string}\0${id as string}`) ?? null;
    },
  };
  // Staged references must resolve to post-state rows (model retention was
  // proven earlier; this pass proves id existence): dangling ids block,
  // and refs changed onto archived rows block — mirroring the pipeline,
  // where unchanged legacy refs to since-archived rows pass but new or
  // changed refs to archived rows fail.
  for (const row of staged) {
    const desiredDef = desiredModels.get(row.targetModel) as InterimModelDef;
    if (desiredDef.refs.length === 0) {
      continue;
    }
    const source = plan.targets.get(row.targetModel) as ModelName | undefined;
    if (source === undefined) {
      throw new StateError(
        'validation',
        `Migration staged a row for sourceless target ${JSON.stringify(row.targetModel as string)}.`,
      );
    }
    const live = liveFor(source as string, row.recordId as string);
    const mapping = plan.models.get(source);
    for (const ref of desiredDef.refs) {
      const value = getDataPath(row.data, ref.field);
      if (value === undefined) {
        continue;
      }
      // The model-level pass already rejects malformed ref values; shape
      // is re-proven here (fail closed) before the id is trusted.
      const targetId =
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as Readonly<Record<string, unknown>>)['id']
          : undefined;
      if (typeof targetId !== 'string' || targetId === '') {
        throw new StateError(
          'validation',
          `Invalid reference in field ${JSON.stringify(ref.field)}.`,
        );
      }
      const target = view.get(ref.model, targetId as RecordId);
      if (target === null) {
        throw new StateError(
          'validation',
          `Migration reference in field ${JSON.stringify(ref.field)} points at missing ` +
            `${JSON.stringify(ref.model as string)}/${JSON.stringify(targetId)}.`,
        );
      }
      // Changed-onto-archived blocks; unchanged legacy refs pass. The old
      // field is the inverse image of the desired ref field (retains map
      // to themselves; fields with no old source are new, hence changed).
      let liveId: string | undefined;
      if (mapping !== undefined) {
        for (const [oldField, handling] of mapping.fields) {
          const desiredField = handling.kind === 'rename' ? handling.to : oldField;
          if (handling.kind !== 'drop' && desiredField === ref.field) {
            const liveValue = getDataPath(live.data, oldField);
            if (
              typeof liveValue === 'object' &&
              liveValue !== null &&
              !Array.isArray(liveValue) &&
              typeof (liveValue as Readonly<Record<string, unknown>>)['id'] === 'string'
            ) {
              liveId = (liveValue as Readonly<Record<string, unknown>>)['id'] as string;
            }
            break;
          }
        }
      }
      if (liveId !== targetId && target.archivedAt !== null) {
        throw new StateError(
          'validation',
          `Migration reference in field ${JSON.stringify(ref.field)} points at archived ` +
            `${JSON.stringify(ref.model as string)}/${JSON.stringify(targetId)}.`,
        );
      }
    }
  }
  for (const desiredDef of desiredModels.values()) {
    for (const invariant of desiredDef.invariants) {
      try {
        await invariant.check(view);
      } catch (error) {
        if (error instanceof StateError) {
          throw new StateError(
            'validation',
            `Migration violates invariant ${JSON.stringify(invariant.name)} on model ` +
              `${JSON.stringify(desiredDef.model as string)}: ${error.message}`,
          );
        }
        throw error;
      }
    }
  }

  // Success: record phase `staged` via an EMPTY staging chunk — the
  // contract upserts progress with no rows, so validation success and its
  // cursor advance commit atomically under the fence.
  const revision = await store.readRevision();
  const next: MigrationProgress = {
    migrationId: plan.migrationId,
    phase: 'staged',
    stagedCursor: progress.stagedCursor,
    publishCursor: null,
    updatedRevision: (revision as number + 1) as Revision,
  };
  try {
    await store.stageMigrationRows({
      expectedRevision: revision,
      migrationId: plan.migrationId,
      rows: [],
      progress: next,
    });
  } catch (error) {
    throw storageToStateError(error);
  }
  return next;
}

/** True when a stored value is the `{ id }` reference shape for one id. */
function isRefToId(value: unknown, id: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return (value as Readonly<Record<string, unknown>>)['id'] === id;
}

/**
 * Drop gating (DESIGN §11.2): every live row of a kind=drop model must be
 * unlocked under its old locks and free of surviving incoming refs.
 * Referrers that are themselves dropped are masked (both vanish in the
 * same migration); referrers with staged rows are judged by their STAGED
 * data — a kept `{ id }` blocks, a removed or retargeted ref masks.
 * Retained-live referrers always block. Rename disposals are moves
 * (their rows are staged, never drop candidates) and stay ungated.
 */
async function checkDropGating(
  store: StoragePort,
  plan: ValidatedMigrationPlan,
  oldModels: ModelTable,
  stagedByTarget: ReadonlyMap<string, StagedRow[]>,
): Promise<void> {
  const dropModels: string[] = [];
  for (const [name, mapping] of plan.models) {
    if (mapping.kind === 'drop') {
      dropModels.push(name as string);
    }
  }
  if (dropModels.length === 0) {
    return;
  }
  // Full candidate enumeration (bounded scans): the planned-drop set
  // doubles as the co-drop masking index for incoming refs.
  const droppedIds = new Map<string, Set<string>>();
  const candidates: Array<{ readonly model: string; readonly row: StoredRow }> = [];
  for (const model of dropModels) {
    const ids = new Set<string>();
    for (const row of await scanAllLive(store, model)) {
      ids.add(row.id as string);
      candidates.push({ model, row });
    }
    droppedIds.set(model, ids);
  }
  if (candidates.length === 0) {
    return;
  }
  const stagedById = new Map<string, StagedRow>();
  for (const [target, rows] of stagedByTarget) {
    for (const row of rows) {
      stagedById.set(`${target}\0${row.recordId as string}`, row);
    }
  }
  for (const { model, row } of candidates) {
    const def = oldModels.get(model as ModelName);
    if (def === undefined) {
      throw new StateError(
        'validation',
        `Migration plan and old defs disagree on ${JSON.stringify(model)}.`,
      );
    }
    // Old locks evaluate on original pre-state: removing still-locked
    // evidence fails (mirrors the pipeline's remove-time lock check).
    for (const lock of def.locks) {
      if (evalPredicateForRow(lock.when, row)) {
        throw new StateError(
          'validation',
          `Migration cannot drop locked row ${JSON.stringify(model)}/` +
            `${JSON.stringify(row.id)} under lock ${JSON.stringify(lock.name)}.`,
        );
      }
    }
  }
  // Incoming refs: every old model's ref paths, archived included
  // (mirrors the pipeline's disposal scan, plus migration masking).
  for (const [refModelName, refDef] of oldModels) {
    if (refDef.refs.length === 0) {
      continue;
    }
    const refModel = refModelName as string;
    const mapping = plan.models.get(refModelName);
    for (const referrer of await scanAllLive(store, refModel)) {
      const referrerId = referrer.id as string;
      for (const ref of refDef.refs) {
        const targetModel = ref.model as string;
        const targetIds = droppedIds.get(targetModel);
        if (targetIds === undefined) {
          continue;
        }
        const value = getDataPath(referrer.data, ref.field);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          continue;
        }
        const targetId = (value as Readonly<Record<string, unknown>>)['id'];
        if (typeof targetId !== 'string' || !targetIds.has(targetId)) {
          continue;
        }
        // A live incoming ref to a drop candidate. Co-dropped referrers
        // vanish with it; staged referrers answer by their staged data.
        if (droppedIds.get(refModel)?.has(referrerId) === true) {
          continue;
        }
        if (
          mapping !== undefined &&
          mapping.needsStaging &&
          mapping.target !== null
        ) {
          const staged = stagedById.get(
            `${mapping.target as string}\0${referrerId}`,
          );
          if (staged === undefined) {
            // Completeness ran first: every live row of a staged model
            // has a staged row, so a miss is an internal inconsistency.
            throw new StateError(
              'validation',
              `Migration staged set misses live row ${JSON.stringify(refModel)}/` +
                `${JSON.stringify(referrerId)}.`,
            );
          }
          const handling = mapping.fields.get(ref.field);
          if (handling === undefined) {
            throw new StateError(
              'validation',
              `Migration plan and old defs disagree on field ${JSON.stringify(ref.field)} ` +
                `of model ${JSON.stringify(refModel)}.`,
            );
          }
          if (handling.kind === 'drop') {
            continue;
          }
          const stagedField = handling.kind === 'rename' ? handling.to : ref.field;
          if (isRefToId(getDataPath(staged.data, stagedField), targetId)) {
            throw new StateError(
              'validation',
              `Migration cannot drop ${JSON.stringify(targetModel)}/` +
                `${JSON.stringify(targetId)}: staged referrer ` +
                `${JSON.stringify(refModel)}/${JSON.stringify(referrerId)} keeps the reference.`,
            );
          }
          continue;
        }
        throw new StateError(
          'validation',
          `Migration cannot drop ${JSON.stringify(targetModel)}/` +
            `${JSON.stringify(targetId)}: retained referrer ` +
            `${JSON.stringify(refModel)}/${JSON.stringify(referrerId)}.`,
        );
      }
    }
  }
}

/** Mutual uniqueness of one row set under one def's unique keys. */
function checkUniqueSet(
  datas: ReadonlyArray<Readonly<Record<string, unknown>>>,
  def: InterimModelDef,
  what: string,
): void {
  const model = def.model as string;
  for (const key of def.uniqueKeys) {
    const seen = new Set<string>();
    for (const data of datas) {
      const value = canonicalUniqueValue(
        Object.hasOwn(data, key)
          ? (data as Readonly<Record<string, unknown>>)[key]
          : undefined,
        key,
        model,
      );
      if (value === null) {
        continue;
      }
      if (seen.has(value)) {
        throw new StateError(
          'validation',
          `Migration duplicate unique value for ${JSON.stringify(key)} on model ` +
            `${JSON.stringify(model)} in ${what}.`,
        );
      }
      seen.add(value);
    }
  }
}

/**
 * Reference targets must resolve to retained/renamed models: staged
 * targets qualify, retained-live models qualify, and anything else
 * (dropped, new-empty, unknown) blocks. No dereference, no scope beyond
 * the same-owner interim (see module note).
 */
function checkRefTargetRetained(
  plan: ValidatedMigrationPlan,
  target: string,
  field: string,
): void {
  if (plan.targets.has(target as ModelName)) {
    return;
  }
  const mapping = plan.models.get(target as ModelName);
  if (
    mapping !== undefined &&
    mapping.kind === 'retain' &&
    !mapping.needsStaging &&
    mapping.target !== null
  ) {
    return;
  }
  throw new StateError(
    'validation',
    `Migration reference in field ${JSON.stringify(field)} targets ` +
      `${JSON.stringify(target)}, which is not a retained or renamed model.`,
  );
}
