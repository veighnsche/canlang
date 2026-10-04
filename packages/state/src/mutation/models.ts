/**
 * Lane 03 S5: INTERIM engine-local mutation model table.
 *
 * INTERIM — marked for outright replacement when L1 compiles model
 * descriptors. Until then, programs hand-build `InterimModelDef` values and
 * the mutation pipeline enforces them. Build-time mistakes throw plain
 * `Error`s as programmer bugs (mirroring `buildPolicyTable`); malformed
 * caller input raises `StateError` validation at write time instead.
 */

import type {
  DeleteMode,
  ModelName,
  QueryPredicate,
  RecordId,
  StoredRow,
} from '../../../contracts/src/state.js';
import { validatePredicateShape } from '../policy/grants.js';

/** Hook operations, by caller intent (`remove` covers the archive path too). */
export type InterimHookOp = 'create' | 'update' | 'remove';

/**
 * Parent-path default: exactly `{ parentPath }`, resolved off the loaded
 * parent row via dot-path lookup. A literal default object that happens to
 * hold exactly one `parentPath` string key is inexpressible interim (it reads
 * as a lookup); every other shape is a literal.
 */
export interface InterimParentPathDefault {
  readonly parentPath: string;
}

/** True for exactly-`{parentPath: string}` defaults (non-array objects only). */
export function isParentPathDefault(value: unknown): value is InterimParentPathDefault {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === 'parentPath' &&
    typeof (value as Record<string, unknown>)['parentPath'] === 'string'
  );
}

/**
 * One interim field: presence requirement, caller-writability, and an
 * optional default. `serverOnly` fields reject caller-supplied values; their
 * values come from defaults, hooks, or (later) server evaluation only.
 * `default` is a JSON literal, or exactly `{ parentPath }` for a parent-row
 * lookup (create only). Without a supplied parent — or when the path does
 * not resolve — the default reads as missing and the required check decides,
 * so optional parent-bound fields never block parentless creates. A supplied
 * parent must exist and be unarchived.
 */
export interface InterimFieldDef {
  readonly required: boolean;
  readonly serverOnly: boolean;
  readonly default?: unknown;
}

/**
 * One interim reference: `field` is a dot path into `data` whose value is a
 * plain `{ id }` object (interim; L2 ref codecs land later), targeting
 * `model`. Used for the archived-target check and disposal scans.
 */
export interface InterimRefDef {
  readonly field: string;
  readonly model: ModelName;
}

/** Hook run context: provisional-before row, caller intent, attribution. */
export interface InterimHookContext {
  readonly before: StoredRow | null;
  readonly op: InterimHookOp;
  readonly actor: string;
  readonly now: number;
}

/**
 * One interim hook: may adjust (return the next candidate) or reject (throw
 * `StateError`). Runs in written order for matching `ops`.
 */
export interface InterimHook {
  readonly name: string;
  readonly ops: ReadonlyArray<InterimHookOp>;
  readonly run: (
    candidate: Record<string, unknown>,
    ctx: InterimHookContext,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

/** Invariant read view over the final provisional state (sync; pre-fetched). */
export interface InterimInvariantView {
  get(model: ModelName, id: RecordId): StoredRow | null;
}

/**
 * One interim invariant: throw `StateError` (`rule_failed`) on violation.
 * Runs once per write-batch pass after all writes provisionalize, in written
 * order, each seeing the final provisional state.
 */
export interface InterimInvariant {
  readonly name: string;
  readonly check: (view: InterimInvariantView) => void | Promise<void>;
}

/**
 * One interim lock: `when` is evaluated against the PRE-state row
 * (provisional-before-this-write); a match rejects with `rule_failed`. The
 * pre-state reading allows lock-establishing transitions (pre unlocked, post
 * locked) while blocking further writes once locked.
 */
export interface InterimLock {
  readonly name: string;
  readonly when: QueryPredicate;
}

/**
 * One interim model: fields, reference paths, top-level unique-key field
 * names, delete behavior, hooks, invariants, and locks. CRUD `by`/`when`
 * live on the CRUD defs (`crud.ts`), not here.
 */
export interface InterimModelDef {
  readonly model: ModelName;
  readonly fields: Record<string, InterimFieldDef>;
  readonly refs: ReadonlyArray<InterimRefDef>;
  readonly uniqueKeys: ReadonlyArray<string>;
  readonly deleteMode: DeleteMode;
  readonly hooks: ReadonlyArray<InterimHook>;
  readonly invariants: ReadonlyArray<InterimInvariant>;
  readonly locks: ReadonlyArray<InterimLock>;
}

/** Validated, frozen model table keyed by model. */
export type ModelTable = ReadonlyMap<ModelName, InterimModelDef>;

/** Build-time dot-path check: non-empty with no empty segments. */
function checkDotPath(path: string, what: string): void {
  if (path === '' || path.split('.').some((segment) => segment === '')) {
    throw new Error(`Invalid ${what} dot path: ${JSON.stringify(path)}`);
  }
}

/** Deep-freeze descriptors so post-build mutation cannot alter enforcement. */
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
 * Validate and freeze interim model defs into a lookup table.
 *
 * Throws plain `Error` on programmer bugs: empty/duplicate model names,
 * malformed field names, non-boolean `required`/`serverOnly`, unserializable
 * or malformed defaults, malformed ref paths or empty ref models, duplicate
 * ref paths, unknown or duplicate unique-key fields, unknown delete modes,
 * malformed hooks/invariants/locks (empty names, dupes, bad ops, non-function
 * `run`/`check`, malformed lock `when` shapes), or non-serializable
 * descriptor data.
 */
export function buildModelTable(models: ReadonlyArray<InterimModelDef>): ModelTable {
  const table = new Map<ModelName, InterimModelDef>();
  for (const def of models) {
    if (typeof def.model !== 'string' || def.model === '') {
      throw new Error('Invalid model def: model names are non-empty strings.');
    }
    const model = def.model as string;
    if (table.has(def.model)) {
      throw new Error(`Duplicate model def: ${JSON.stringify(model)}`);
    }
    if (typeof def.fields !== 'object' || def.fields === null || Array.isArray(def.fields)) {
      throw new Error(`Invalid model ${JSON.stringify(model)}: fields must be an object.`);
    }
    for (const [name, field] of Object.entries(def.fields)) {
      if (typeof field !== 'object' || field === null || Array.isArray(field)) {
        throw new Error(
          `Invalid field ${JSON.stringify(name)} on model ${JSON.stringify(model)}: ` +
            'field defs must be objects.',
        );
      }
      if (name === '' || name.includes('.')) {
        throw new Error(
          `Invalid field name ${JSON.stringify(name)} on model ${JSON.stringify(model)}: ` +
            'top-level names are non-empty single segments.',
        );
      }
      if (typeof field.required !== 'boolean' || typeof field.serverOnly !== 'boolean') {
        throw new Error(
          `Invalid field ${JSON.stringify(name)} on model ${JSON.stringify(model)}: ` +
            'required and serverOnly must be booleans.',
        );
      }
      if (field.default !== undefined) {
        if (isParentPathDefault(field.default)) {
          checkDotPath(field.default.parentPath, `default parentPath for ${JSON.stringify(name)}`);
        } else {
          try {
            structuredClone(field.default);
          } catch {
            throw new Error(
              `Invalid default for field ${JSON.stringify(name)} on model ` +
                `${JSON.stringify(model)}: defaults must be serializable data.`,
            );
          }
        }
      }
    }
    if (!Array.isArray(def.refs)) {
      throw new Error(`Invalid model ${JSON.stringify(model)}: refs must be an array.`);
    }
    const refFields = new Set<string>();
    for (const ref of def.refs) {
      if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) {
        throw new Error(
          `Invalid ref on model ${JSON.stringify(model)}: ref defs must be objects.`,
        );
      }
      if (typeof ref.field !== 'string') {
        throw new Error(
          `Invalid ref on model ${JSON.stringify(model)}: ref fields are dot-path strings.`,
        );
      }
      checkDotPath(ref.field, `ref field on model ${JSON.stringify(model)}`);
      if (typeof ref.model !== 'string' || ref.model === '') {
        throw new Error(
          `Invalid ref ${JSON.stringify(ref.field)} on model ${JSON.stringify(model)}: ` +
            'target models are non-empty strings.',
        );
      }
      if (refFields.has(ref.field)) {
        throw new Error(
          `Duplicate ref field ${JSON.stringify(ref.field)} on model ${JSON.stringify(model)}.`,
        );
      }
      refFields.add(ref.field);
    }
    if (!Array.isArray(def.uniqueKeys)) {
      throw new Error(`Invalid model ${JSON.stringify(model)}: uniqueKeys must be an array.`);
    }
    const seenKeys = new Set<string>();
    for (const key of def.uniqueKeys) {
      if (typeof key !== 'string' || key === '') {
        throw new Error(
          `Invalid unique key on model ${JSON.stringify(model)}: keys are non-empty field names.`,
        );
      }
      if (!Object.hasOwn(def.fields, key)) {
        throw new Error(
          `Unknown unique-key field ${JSON.stringify(key)} on model ${JSON.stringify(model)}.`,
        );
      }
      if (seenKeys.has(key)) {
        throw new Error(
          `Duplicate unique key ${JSON.stringify(key)} on model ${JSON.stringify(model)}.`,
        );
      }
      seenKeys.add(key);
    }
    if (def.deleteMode !== 'archive' && def.deleteMode !== 'remove' && def.deleteMode !== 'none') {
      throw new Error(
        `Invalid deleteMode on model ${JSON.stringify(model)}: ${JSON.stringify(def.deleteMode)}.`,
      );
    }
    if (!Array.isArray(def.hooks)) {
      throw new Error(`Invalid model ${JSON.stringify(model)}: hooks must be an array.`);
    }
    const hookNames = new Set<string>();
    for (const hook of def.hooks) {
      if (typeof hook.name !== 'string' || hook.name === '') {
        throw new Error(
          `Invalid hook on model ${JSON.stringify(model)}: names are non-empty strings.`,
        );
      }
      if (hookNames.has(hook.name)) {
        throw new Error(
          `Duplicate hook ${JSON.stringify(hook.name)} on model ${JSON.stringify(model)}.`,
        );
      }
      hookNames.add(hook.name);
      if (!Array.isArray(hook.ops) || hook.ops.length === 0) {
        throw new Error(
          `Invalid hook ${JSON.stringify(hook.name)} on model ${JSON.stringify(model)}: ` +
            'ops needs a non-empty array.',
        );
      }
      for (const op of hook.ops) {
        if (op !== 'create' && op !== 'update' && op !== 'remove') {
          throw new Error(
            `Invalid hook ${JSON.stringify(hook.name)} on model ${JSON.stringify(model)}: ` +
              `unknown op ${JSON.stringify(op)}.`,
          );
        }
      }
      if (typeof hook.run !== 'function') {
        throw new Error(
          `Invalid hook ${JSON.stringify(hook.name)} on model ${JSON.stringify(model)}: ` +
            'run must be a function.',
        );
      }
    }
    if (!Array.isArray(def.invariants)) {
      throw new Error(`Invalid model ${JSON.stringify(model)}: invariants must be an array.`);
    }
    const invariantNames = new Set<string>();
    for (const invariant of def.invariants) {
      if (typeof invariant.name !== 'string' || invariant.name === '') {
        throw new Error(
          `Invalid invariant on model ${JSON.stringify(model)}: names are non-empty strings.`,
        );
      }
      if (invariantNames.has(invariant.name)) {
        throw new Error(
          `Duplicate invariant ${JSON.stringify(invariant.name)} on model ${JSON.stringify(model)}.`,
        );
      }
      invariantNames.add(invariant.name);
      if (typeof invariant.check !== 'function') {
        throw new Error(
          `Invalid invariant ${JSON.stringify(invariant.name)} on model ` +
            `${JSON.stringify(model)}: check must be a function.`,
        );
      }
    }
    if (!Array.isArray(def.locks)) {
      throw new Error(`Invalid model ${JSON.stringify(model)}: locks must be an array.`);
    }
    const lockNames = new Set<string>();
    for (const lock of def.locks) {
      if (typeof lock.name !== 'string' || lock.name === '') {
        throw new Error(
          `Invalid lock on model ${JSON.stringify(model)}: names are non-empty strings.`,
        );
      }
      if (lockNames.has(lock.name)) {
        throw new Error(
          `Duplicate lock ${JSON.stringify(lock.name)} on model ${JSON.stringify(model)}.`,
        );
      }
      lockNames.add(lock.name);
      try {
        validatePredicateShape(lock.when);
      } catch (error) {
        throw new Error(
          `Invalid lock ${JSON.stringify(lock.name)} when on model ${JSON.stringify(model)}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    let fields: Record<string, InterimFieldDef>;
    let refs: InterimRefDef[];
    let uniqueKeys: string[];
    let whens: QueryPredicate[];
    try {
      fields = structuredClone(def.fields);
      refs = structuredClone([...def.refs]);
      uniqueKeys = structuredClone([...def.uniqueKeys]);
      whens = def.locks.map((lock) => structuredClone(lock.when));
    } catch {
      throw new Error(
        `Invalid model ${JSON.stringify(model)}: descriptors must be serializable data.`,
      );
    }
    const frozenLocks: InterimLock[] = [];
    for (let index = 0; index < def.locks.length; index += 1) {
      const lock = def.locks[index];
      const when = whens[index];
      if (lock === undefined || when === undefined) {
        throw new Error(`Invalid model ${JSON.stringify(model)}: lock table misaligned.`);
      }
      frozenLocks.push(Object.freeze({ name: lock.name, when: deepFreeze(when) }));
    }
    table.set(
      def.model,
      Object.freeze({
        model: def.model,
        fields: deepFreeze(fields),
        refs: deepFreeze(refs),
        uniqueKeys: Object.freeze(uniqueKeys),
        deleteMode: def.deleteMode,
        hooks: Object.freeze(
          def.hooks.map((hook) =>
            Object.freeze({ name: hook.name, ops: Object.freeze([...hook.ops]), run: hook.run }),
          ),
        ),
        invariants: Object.freeze(
          def.invariants.map((invariant) =>
            Object.freeze({ name: invariant.name, check: invariant.check }),
          ),
        ),
        locks: Object.freeze(frozenLocks),
      }) as InterimModelDef,
    );
  }
  return table;
}
