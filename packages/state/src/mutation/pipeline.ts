/**
 * Lane 03 S5: mutation write pipeline (provisional writes, uniques, history).
 *
 * `runMutationWrites` evaluates an ordered batch of create/update/remove
 * writes against a provisional map layered over the store, returning the
 * fenced-commit inputs (domain writes, history, unique claims/releases) plus
 * receipt `resolvedDefaults`. It commits nothing itself; callers commit the
 * result with the admission fence. All decisions below are the S5 spec,
 * documented inline.
 */

import type {
  DomainWrite,
  HistoryEntry,
  InvocationContext,
  ModelName,
  QueryPredicate,
  RecordId,
  RecordParent,
  RecordVersion,
  StoredRow,
  UniqueClaim,
  UniqueRelease,
} from '../../../contracts/src/state.js';
import type { StoragePort } from '../storage/port.js';
import { StateError } from '../errors.js';
import { jsonClone } from '../internal/json.js';
import { evalPredicateForRow, resolveRowPath } from '../policy/grants.js';
import { isParentPathDefault, type InterimModelDef, type ModelTable } from './models.js';

/**
 * One caller write. `data` is create data or an update patch (`undefined`
 * reads as `{}`); `parent` is create-only (update/remove carrying one is
 * rejected: parent linkage is immutable); `when` is an optional candidate
 * precondition supplied by the CRUD defs.
 */
export interface MutationWrite {
  readonly op: 'create' | 'update' | 'remove';
  readonly model: ModelName;
  readonly id?: RecordId;
  readonly parent?: RecordParent;
  readonly data?: Record<string, unknown>;
  readonly when?: QueryPredicate;
}

/** Pipeline input: model table, ordered writes, frozen context, store. */
export interface MutationWritesInput {
  readonly table: ModelTable;
  readonly writes: ReadonlyArray<MutationWrite>;
  readonly context: InvocationContext;
  readonly store: StoragePort;
}

/**
 * Pipeline output: fenced-commit inputs plus receipt defaults.
 *
 * INTERIM: `resolvedDefaults` is flat per batch, so multi-write batches with
 * same-named defaulted fields across models collide (last wins in the
 * receipt). Unreachable via single-write crudExecute; scenarios will key
 * defaults per write.
 */
export interface MutationWritesResult {
  readonly writes: DomainWrite[];
  readonly history: HistoryEntry[];
  readonly uniqueClaims: UniqueClaim[];
  readonly uniqueReleases: UniqueRelease[];
  readonly resolvedDefaults: Record<string, unknown>;
}

/** Provisional entry: a staged row, or a removal masking the store. */
type ProvisionalEntry =
  | { readonly status: 'row'; readonly row: StoredRow }
  | { readonly status: 'removed' };

function keyOf(model: ModelName, id: RecordId): string {
  return `${model as string}\0${id as string}`;
}

/** History/row actor attribution for a context (S5: `test` kinds sign `test`). */
function actorFor(context: InvocationContext): string {
  return (
    context.actor?.userId ?? (context.kind === 'test' ? 'test' : (context.trustedSource ?? 'public'))
  );
}

/** Prototype-safe property definition for caller-keyed candidate objects. */
function safeSet(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Deep-freeze staged rows so invariant views cannot mutate provisional state. */
function deepFreeze<T>(value: T, seen: Set<unknown> = new Set()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry, seen);
    }
  } else {
    for (const entry of Object.values(value)) {
      deepFreeze(entry, seen);
    }
  }
  return Object.freeze(value);
}

/**
 * Data-only dot-path read (arrays are opaque leaves, mirroring
 * `resolveRowPath`). Missing or untraversable paths yield `undefined`.
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

/**
 * Reference equality by target id: interim values are plain `{ id }`, so two
 * values with the same non-empty string id are unchanged (extra keys, if any,
 * are ignored).
 */
function refValuesEqual(oldValue: unknown, newValue: unknown): boolean {
  if (Object.is(oldValue, newValue)) {
    return true;
  }
  if (typeof oldValue !== 'object' || oldValue === null || Array.isArray(oldValue)) {
    return false;
  }
  if (typeof newValue !== 'object' || newValue === null || Array.isArray(newValue)) {
    return false;
  }
  const oldId = (oldValue as Readonly<Record<string, unknown>>)['id'];
  const newId = (newValue as Readonly<Record<string, unknown>>)['id'];
  return typeof oldId === 'string' && oldId !== '' && oldId === newId;
}

/**
 * Evaluate an ordered batch of mutation writes. Per-write order: resolve the
 * model def, load `before` (provisional-aware), build the candidate, run
 * hooks, check `when`/locks/refs, stage uniques, provisionalize, and record
 * history. Invariants run once after ALL writes provisionalize, in write
 * order then def order (a model touched twice runs its invariants twice),
 * each seeing the final provisional state.
 *
 * INTERIM LIMITATION: same-batch self-canceling writes (create+remove one
 * id) emit both a claim and a release for one key, but stores apply releases
 * first — direct multi-write callers must not emit both. Unreachable via
 * crudExecute (single write per call); scenarios will stage net uniques.
 */
export async function runMutationWrites(input: MutationWritesInput): Promise<MutationWritesResult> {
  const { table, writes, context, store } = input;
  const now = context.now;
  const actor = actorFor(context);
  const provisional = new Map<string, ProvisionalEntry>();
  const outWrites: DomainWrite[] = [];
  const outHistory: HistoryEntry[] = [];
  const outClaims: UniqueClaim[] = [];
  const outReleases: UniqueRelease[] = [];
  const resolvedDefaults: Record<string, unknown> = {};
  const touchedDefs: InterimModelDef[] = [];

  /** Provisional-aware load: staged rows win, removals mask, else the store. */
  const getRow = async (model: ModelName, id: RecordId): Promise<StoredRow | null> => {
    const entry = provisional.get(keyOf(model, id));
    if (entry !== undefined) {
      return entry.status === 'row' ? entry.row : null;
    }
    return store.load(model, id);
  };

  /** Full-model scan (archived included) with provisional merged over it. */
  const scanModel = async (model: ModelName): Promise<StoredRow[]> => {
    const base = await store.query({ model, authority: 'owner', archived: 'include' });
    const merged = new Map<string, StoredRow>();
    for (const row of base) {
      merged.set(keyOf(model, row.id), row);
    }
    const prefix = `${model as string}\0`;
    for (const [key, entry] of provisional) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      if (entry.status === 'row') {
        merged.set(key, entry.row);
      } else {
        merged.delete(key);
      }
    }
    return [...merged.values()];
  };

  /** Required check: missing keys, nulls, and hook-set undefined all fail. */
  const checkRequired = (candidate: Readonly<Record<string, unknown>>, def: InterimModelDef): void => {
    for (const [field, fieldDef] of Object.entries(def.fields)) {
      if (!fieldDef.required) {
        continue;
      }
      const value = candidate[field];
      if (!Object.hasOwn(candidate, field) || value === null || value === undefined) {
        throw new StateError('validation', `Missing required field ${JSON.stringify(field)}.`);
      }
    }
  };

  /** Create data / update patch normalization (`undefined` reads as `{}`). */
  const asDataObject = (value: unknown, what: string): Record<string, unknown> => {
    if (value === undefined) {
      return {};
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new StateError('validation', `${what} must be an object.`);
    }
    return value as Record<string, unknown>;
  };

  /** Copy caller data in, rejecting unknown and server-only fields. */
  const applyCallerData = (
    target: Record<string, unknown>,
    data: Record<string, unknown>,
    def: InterimModelDef,
  ): void => {
    for (const [field, value] of Object.entries(data)) {
      const fieldDef = def.fields[field];
      if (fieldDef === undefined) {
        throw new StateError(
          'validation',
          `Unknown field ${JSON.stringify(field)} for model ${JSON.stringify(def.model as string)}.`,
        );
      }
      // Patch/data keys with `undefined` values are IGNORED (absent): they
      // neither set nor delete. `null` is a real value (fails `required`).
      if (value === undefined) {
        continue;
      }
      if (fieldDef.serverOnly) {
        throw new StateError(
          'validation',
          `Field ${JSON.stringify(field)} is server-only and cannot be supplied.`,
        );
      }
      safeSet(target, field, jsonClone(value, `Field ${JSON.stringify(field)}`));
    }
  };

  /**
   * Post-hook field-name check: hooks may set server-only fields, but never
   * undeclared ones — downstream readers assume the model contract. Runs on
   * every path after hooks (caller data was already checked on the way in).
   */
  const checkKnownFields = (
    candidate: Readonly<Record<string, unknown>>,
    def: InterimModelDef,
  ): void => {
    for (const field of Object.keys(candidate)) {
      if (!Object.hasOwn(def.fields, field)) {
        throw new StateError(
          'validation',
          `Unknown field ${JSON.stringify(field)} for model ${JSON.stringify(def.model as string)}.`,
        );
      }
    }
  };

  /**
   * Post-hook JSON-safety probe: bigints and circular refs survive cloning
   * but crash commit-time JSON encoding with a raw TypeError. Reject them as
   * caller validation instead (bigint money minors stay rejected interim
   * until the L2 codec join, matching the S4 read stance).
   */
  const checkJsonSafe = (
    candidate: Readonly<Record<string, unknown>>,
    def: InterimModelDef,
  ): void => {
    try {
      JSON.stringify(candidate);
    } catch {
      throw new StateError(
        'validation',
        `Candidate for model ${JSON.stringify(def.model as string)} holds non-JSON values.`,
      );
    }
  };

  /** Run matching hooks in written order; each gets a clone, returns next. */
  const runHooks = async (
    def: InterimModelDef,
    op: 'create' | 'update' | 'remove',
    candidate: Record<string, unknown>,
    before: StoredRow | null,
  ): Promise<Record<string, unknown>> => {
    let current = candidate;
    for (const hook of def.hooks) {
      if (!hook.ops.includes(op)) {
        continue;
      }
      // Each hook gets a clone and its return is re-cloned: hooks can neither
      // mutate the pipeline candidate nor smuggle uncloneable values forward
      // (or retain an alias and mutate it after returning).
      const next = await hook.run(jsonClone(current, 'Hook candidate'), {
        before,
        op,
        actor,
        now,
      });
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        throw new Error(
          `Hook ${JSON.stringify(hook.name)} on model ${JSON.stringify(def.model as string)} ` +
            'must return a candidate object.',
        );
      }
      current = jsonClone(next as Record<string, unknown>, 'Hook result');
    }
    return current;
  };

  /** Candidate precondition: false reads as `rule_failed`, never silent. */
  const checkWhen = (when: QueryPredicate | undefined, probe: StoredRow): void => {
    if (when !== undefined && !evalPredicateForRow(when, probe)) {
      throw new StateError('rule_failed', 'Precondition failed.');
    }
  };

  /** Lock check against the PRE-state row (provisional-before-this-write). */
  const checkLocks = (def: InterimModelDef, before: StoredRow): void => {
    for (const lock of def.locks) {
      if (evalPredicateForRow(lock.when, before)) {
        throw new StateError('rule_failed', 'Record is locked.');
      }
    }
  };

  /**
   * Reference check: on create every present ref is validated; on update only
   * refs whose value DIFFERS from before (unchanged refs pass untouched, even
   * when their target has since archived). Values must be `{ id }`, targets
   * must exist and be unarchived.
   */
  const checkRefs = async (
    def: InterimModelDef,
    candidate: Readonly<Record<string, unknown>>,
    before: StoredRow | null,
  ): Promise<void> => {
    for (const ref of def.refs) {
      const value = getDataPath(candidate, ref.field);
      if (value === undefined) {
        continue;
      }
      if (before !== null && refValuesEqual(getDataPath(before.data, ref.field), value)) {
        continue;
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new StateError('validation', `Invalid reference in field ${JSON.stringify(ref.field)}.`);
      }
      const targetId = (value as Readonly<Record<string, unknown>>)['id'];
      if (typeof targetId !== 'string' || targetId === '') {
        throw new StateError('validation', `Invalid reference in field ${JSON.stringify(ref.field)}.`);
      }
      const target = await getRow(ref.model, targetId as RecordId);
      if (target === null) {
        throw new StateError('validation', 'Invalid reference.');
      }
      if (target.archivedAt !== null) {
        throw new StateError('validation', 'References to archived records are blocked.');
      }
    }
  };

  /**
   * Unique-key canonicalization: strings as-is; numbers/booleans via
   * `String()`; bigints via `toString()`; null/undefined/missing claim
   * nothing (nulls are not unique-constrained); anything else is a caller
   * error, never a silent skip.
   */
  const canonicalUnique = (value: unknown, key: string, def: InterimModelDef): string | null => {
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
      `Unique field ${JSON.stringify(key)} on model ${JSON.stringify(def.model as string)} ` +
        'must be a scalar value.',
    );
  };

  /**
   * Disposal scan for hard removes: every ref path of every table model is
   * scanned (archived included, provisional merged); any live value pointing
   * at the target rejects. A referrer removed EARLIER in the batch already
   * masks itself; one removed later still blocks — order co-removals
   * referrer-first.
   */
  const checkDisposal = async (targetModel: ModelName, targetId: RecordId): Promise<void> => {
    for (const [model, modelDef] of table) {
      if (modelDef.refs.length === 0) {
        continue;
      }
      const rows = await scanModel(model);
      for (const row of rows) {
        for (const ref of modelDef.refs) {
          if ((ref.model as string) !== (targetModel as string)) {
            continue;
          }
          const value = getDataPath(row.data, ref.field);
          if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            continue;
          }
          if ((value as Readonly<Record<string, unknown>>)['id'] === (targetId as string)) {
            throw new StateError('rule_failed', 'Cannot remove: incoming references exist.');
          }
        }
      }
    }
  };

  /** Record one history entry with full before/after data (authority record). */
  const recordHistory = (entry: {
    readonly model: ModelName;
    readonly recordId: RecordId;
    readonly version: RecordVersion;
    readonly change: 'create' | 'update' | 'archive' | 'remove';
    readonly before: StoredRow | null;
    readonly after: Readonly<Record<string, unknown>> | null;
  }): void => {
    outHistory.push({
      model: entry.model,
      recordId: entry.recordId,
      version: entry.version,
      operation: context.operation,
      operationId: context.operationId,
      actor,
      at: now,
      change: entry.change,
      before: entry.before === null ? null : structuredClone(entry.before.data),
      after: entry.after === null ? null : structuredClone(entry.after),
    });
  };

  for (const write of writes) {
    const def = table.get(write.model);
    if (def === undefined) {
      // Unknown models are programmer bugs: models come from program defs,
      // never from caller input.
      throw new Error(
        `Unknown model in mutation write: ${JSON.stringify(write.model as string)}.`,
      );
    }
    touchedDefs.push(def);
    const id = write.id;
    if (typeof id !== 'string' || id === '') {
      throw new StateError('validation', 'Mutation writes need a non-empty string record id.');
    }
    // Admission pre-loads update/remove targets, but the pipeline re-loads
    // via the provisional map for uniformity (batch-earlier writes visible).
    const before = await getRow(write.model, id);

    if (write.op === 'create') {
      if (before !== null) {
        throw new StateError('validation', 'Record already exists.');
      }
      if (write.parent !== undefined) {
        if (
          typeof write.parent.model !== 'string' ||
          write.parent.model === '' ||
          typeof write.parent.id !== 'string' ||
          write.parent.id === ''
        ) {
          throw new StateError('validation', 'Invalid parent reference.');
        }
      }
      const candidate: Record<string, unknown> = {};
      applyCallerData(candidate, asDataObject(write.data, 'Create data'), def);
      // Supplied parents must exist and be unarchived; resolved once here and
      // reused for parent-path defaults below.
      let parent: RecordParent | null = null;
      let parentRow: StoredRow | null = null;
      if (write.parent !== undefined) {
        parentRow = await getRow(write.parent.model, write.parent.id);
        if (parentRow === null) {
          throw new StateError('validation', 'Parent record not found.');
        }
        if (parentRow.archivedAt !== null) {
          throw new StateError('validation', 'Parent record is archived.');
        }
        parent = { model: write.parent.model, id: write.parent.id };
      }
      for (const [field, fieldDef] of Object.entries(def.fields)) {
        if (Object.hasOwn(candidate, field)) {
          continue;
        }
        const fallback = fieldDef.default;
        if (fallback === undefined) {
          // T16a: no default — the T09 array marker decides. Ordinary
          // arrays omit to `[]` (recorded like any resolved omission-fill);
          // required arrays reject omission outright. Explicit defaults
          // (handled below) always win over omit-to-empty.
          const marker = fieldDef.array;
          if (marker === undefined) {
            continue;
          }
          if (marker.required) {
            throw new StateError('validation', `Missing required field ${JSON.stringify(field)}.`);
          }
          safeSet(candidate, field, []);
          safeSet(resolvedDefaults, field, []);
          continue;
        }
        if (isParentPathDefault(fallback)) {
          // No parent, or an unresolvable path, reads as missing — the
          // required check below decides, so optional parent-bound fields
          // never block parentless creates.
          if (parentRow === null) {
            continue;
          }
          const resolved = resolveRowPath(parentRow, fallback.parentPath);
          // An unresolvable parent path reads as missing (the required check
          // below decides); only recorded when it actually defaults.
          if (resolved === undefined) {
            continue;
          }
          safeSet(candidate, field, structuredClone(resolved));
          safeSet(resolvedDefaults, field, structuredClone(resolved));
        } else {
          safeSet(candidate, field, structuredClone(fallback));
          safeSet(resolvedDefaults, field, structuredClone(fallback));
        }
      }
      checkRequired(candidate, def);
      const hooked = await runHooks(def, 'create', candidate, null);
      // Hooks are trusted otherwise (they may set server-only fields), but
      // the contract checks re-run: no undeclared fields, required present,
      // JSON-safe values.
      checkKnownFields(hooked, def);
      checkRequired(hooked, def);
      checkJsonSafe(hooked, def);
      checkWhen(write.when, {
        id,
        version: 1 as RecordVersion,
        created: now,
        updated: now,
        createdBy: actor,
        updatedBy: actor,
        archivedAt: null,
        parent,
        data: hooked,
      });
      // Creates skip locks: there is no pre-state to match against.
      await checkRefs(def, hooked, null);
      for (const key of def.uniqueKeys) {
        const canonical = canonicalUnique(hooked[key], key, def);
        if (canonical === null) {
          continue;
        }
        outClaims.push({ model: write.model, keyName: key, keyValue: canonical, recordId: id });
      }
      const row: StoredRow = {
        id,
        version: 1 as RecordVersion,
        created: now,
        updated: now,
        createdBy: actor,
        updatedBy: actor,
        archivedAt: null,
        parent,
        data: deepFreeze(hooked),
      };
      provisional.set(keyOf(write.model, id), { status: 'row', row });
      outWrites.push({ kind: 'insert', model: write.model, row });
      recordHistory({
        model: write.model,
        recordId: id,
        version: 1 as RecordVersion,
        change: 'create',
        before: null,
        after: hooked,
      });
      continue;
    }

    if (write.op === 'update') {
      if (before === null) {
        throw new StateError('not_found', 'Record not found.');
      }
      // Archived rows stay updatable here BY DESIGN: canonical admission
      // gates archived targets for every invoke-path write (CRUD now,
      // scenarios later), while direct pipeline callers (privileged: future
      // migrations/backfill) may legitimately touch archived rows.
      if (write.parent !== undefined) {
        throw new StateError('validation', 'Parent linkage is immutable.');
      }
      const candidate: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(before.data)) {
        safeSet(candidate, field, structuredClone(value));
      }
      // Updates apply NO defaults: only the patch lands on before.data.
      applyCallerData(candidate, asDataObject(write.data, 'Update patch'), def);
      checkRequired(candidate, def);
      const hooked = await runHooks(def, 'update', candidate, before);
      checkKnownFields(hooked, def);
      checkRequired(hooked, def);
      checkJsonSafe(hooked, def);
      checkWhen(write.when, {
        id,
        version: (before.version + 1) as RecordVersion,
        created: before.created,
        updated: now,
        createdBy: before.createdBy,
        updatedBy: actor,
        archivedAt: before.archivedAt,
        parent: before.parent ?? null,
        data: hooked,
      });
      checkLocks(def, before);
      await checkRefs(def, hooked, before);
      for (const key of def.uniqueKeys) {
        const oldCanonical = canonicalUnique(before.data[key], key, def);
        const newCanonical = canonicalUnique(hooked[key], key, def);
        if (oldCanonical === newCanonical) {
          continue;
        }
        if (oldCanonical !== null) {
          outReleases.push({ model: write.model, keyName: key, keyValue: oldCanonical });
        }
        if (newCanonical !== null) {
          outClaims.push({
            model: write.model,
            keyName: key,
            keyValue: newCanonical,
            recordId: id,
          });
        }
      }
      const row: StoredRow = {
        id,
        version: (before.version + 1) as RecordVersion,
        created: before.created,
        updated: now,
        createdBy: before.createdBy,
        updatedBy: actor,
        archivedAt: before.archivedAt,
        parent: before.parent ?? null,
        data: deepFreeze(hooked),
      };
      provisional.set(keyOf(write.model, id), { status: 'row', row });
      outWrites.push({
        kind: 'update',
        model: write.model,
        id,
        expectedVersion: before.version,
        row,
      });
      recordHistory({
        model: write.model,
        recordId: id,
        version: row.version,
        change: 'update',
        before,
        after: hooked,
      });
      continue;
    }

    if (write.op !== 'remove') {
      throw new Error(`Unknown mutation op: ${JSON.stringify(write.op)}.`);
    }
    if (before === null) {
      throw new StateError('not_found', 'Record not found.');
    }
    if (write.parent !== undefined) {
      throw new StateError('validation', 'Parent linkage is immutable.');
    }
    const mode = def.deleteMode;
    if (mode === 'none') {
      throw new StateError('validation', 'Deletes are not allowed for this model.');
    }
    if (mode === 'archive' && before.archivedAt !== null) {
      throw new StateError('validation', 'Record is already archived.');
    }
    // Archive AND hard remove both run hooks filtered to op 'remove' (caller
    // intent); the hard-remove candidate is discarded, but hook rejections
    // still block the delete.
    const hooked = await runHooks(def, 'remove', jsonClone(before.data, 'Remove hook input'), before);
    if (mode === 'archive') {
      checkKnownFields(hooked, def);
      checkRequired(hooked, def);
      checkJsonSafe(hooked, def);
      checkWhen(write.when, {
        id,
        version: (before.version + 1) as RecordVersion,
        created: before.created,
        updated: now,
        createdBy: before.createdBy,
        updatedBy: actor,
        archivedAt: now,
        parent: before.parent ?? null,
        data: hooked,
      });
    } else {
      // Hard removes have no candidate: `when` reads as a precondition over
      // the before row (`may delete when <before matches>`).
      checkWhen(write.when, before);
    }
    checkLocks(def, before);
    if (mode === 'archive') {
      // Archive keeps uniques reserved and skips the disposal scan (the row
      // stays, so incoming refs stay valid). Refs re-validate like
      // create/update (a hook-set ref to a missing/archived target must not
      // persist; unchanged refs still pass). Uniques diff like an update: a
      // hook-adjusted unique value must move its claim, or the stored row
      // and the unique index diverge.
      await checkRefs(def, hooked, before);
      for (const key of def.uniqueKeys) {
        const oldCanonical = canonicalUnique(before.data[key], key, def);
        const newCanonical = canonicalUnique(hooked[key], key, def);
        if (oldCanonical === newCanonical) {
          continue;
        }
        if (oldCanonical !== null) {
          outReleases.push({ model: write.model, keyName: key, keyValue: oldCanonical });
        }
        if (newCanonical !== null) {
          outClaims.push({
            model: write.model,
            keyName: key,
            keyValue: newCanonical,
            recordId: id,
          });
        }
      }
      const row: StoredRow = {
        id,
        version: (before.version + 1) as RecordVersion,
        created: before.created,
        updated: now,
        createdBy: before.createdBy,
        updatedBy: actor,
        archivedAt: now,
        parent: before.parent ?? null,
        data: deepFreeze(hooked),
      };
      provisional.set(keyOf(write.model, id), { status: 'row', row });
      outWrites.push({
        kind: 'update',
        model: write.model,
        id,
        expectedVersion: before.version,
        row,
      });
      recordHistory({
        model: write.model,
        recordId: id,
        version: row.version,
        change: 'archive',
        before,
        after: hooked,
      });
    } else {
      await checkDisposal(write.model, id);
      for (const key of def.uniqueKeys) {
        const canonical = canonicalUnique(before.data[key], key, def);
        if (canonical === null) {
          continue;
        }
        outReleases.push({ model: write.model, keyName: key, keyValue: canonical });
      }
      provisional.set(keyOf(write.model, id), { status: 'removed' });
      outWrites.push({ kind: 'remove', model: write.model, id, expectedVersion: before.version });
      recordHistory({
        model: write.model,
        recordId: id,
        version: before.version,
        change: 'remove',
        before,
        after: null,
      });
    }
  }

  // Invariants see the final provisional state through a SYNC view, so every
  // table model is pre-materialized (archived included, provisional merged,
  // frozen). The full-table scan is interim-correct over unbounded stores;
  // L1/L2 narrow it.
  const cache = new Map<string, StoredRow>();
  for (const [model] of table) {
    const rows = await scanModel(model);
    for (const row of rows) {
      cache.set(keyOf(model, row.id), deepFreeze(row));
    }
  }
  for (const def of touchedDefs) {
    for (const invariant of def.invariants) {
      await invariant.check({
        get(model: ModelName, id: RecordId): StoredRow | null {
          if (!table.has(model)) {
            throw new Error(`Invariant queried unknown model ${JSON.stringify(model as string)}.`);
          }
          return cache.get(keyOf(model, id)) ?? null;
        },
      });
    }
  }

  return {
    writes: outWrites,
    history: outHistory,
    uniqueClaims: outClaims,
    uniqueReleases: outReleases,
    resolvedDefaults,
  };
}
