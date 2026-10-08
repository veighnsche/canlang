/**
 * Lane 03 S5: INTERIM engine-local mutation model table.
 *
 * INTERIM — marked for outright replacement when L1 compiles model
 * descriptors. Until then, programs hand-build `InterimModelDef` values and
 * the mutation pipeline enforces them. Build-time mistakes throw plain
 * `Error`s as programmer bugs (mirroring `buildPolicyTable`); malformed
 * caller input raises `StateError` validation at write time instead.
 */

import { deepFreeze } from '../internal/own-data.js';
import type {
  CanTypeId,
  CanonicalModelDescriptor,
  FieldMachine,
  DeleteMode,
  ModelName,
  OperationName,
  QueryPredicate,
  RecordId,
  RecordParent,
  Revision,
  StoredRow,
} from '@canlang/contracts';
import type { FenceScope } from '../invocation/admission.js';
import { checkFieldMachine } from '../internal/machine.js';
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
 * T18 engine-resolvable server initializer (mirrors the loader's
 * `ServerInitKind` without importing the invocation layer: `actor` stamps
 * the invoking actor as a wire `{id}` user value, `now` stamps the frozen
 * invocation clock as an RFC 3339 millis datetime string, `random_secret`
 * mints fresh opaque hex material per execution).
 */
export type InterimServerInit = 'actor' | 'now' | 'random_secret';

/**
 * One interim field: presence requirement, caller-writability, and an
 * optional default. `serverOnly` fields reject caller-supplied values; their
 * values come from defaults, hooks, or server evaluation only.
 * `default` is a JSON literal, or exactly `{ parentPath }` for a parent-row
 * lookup (create only). Without a supplied parent — or when the path does
 * not resolve — the default reads as missing and the required check decides,
 * so optional parent-bound fields never block parentless creates. A supplied
 * parent must exist and be unarchived.
 *
 * T16a: `array` records the T09 array marker for array fields (absent means
 * singular): ordinary arrays (`required: false`) omit to empty on create,
 * required arrays (`required: true`) reject omission. Absent on hand-built
 * interim defs, which keep their exact prior behavior.
 *
 * T18: `server` records the closed-set engine initializer for a
 * server-resolved field, evaluated at creation for omitted fields only
 * (after literal/parent defaults and the null/array fills, before hooks
 * — hooks observe the resolved value and, per the adopted R27 rule, are
 * the only writers that may adjust it). Mutually exclusive with
 * `default` (source spellings are exclusive too). Absent on hand-built
 * interim defs, which keep their exact prior behavior.
 *
 * T18: `nullable: true` records a KNOWN-nullable field (artifact
 * declared): omitted fills null on create (L2 parity, before the
 * array-empty fill — nullable arrays yield null). Absent reads as
 * unknown: no fill, exact prior behavior (hand-built defs and
 * fixtures omit it).
 */
export interface InterimFieldDef {
  /** Checked association for the pipeline's optional runtime conversion checkpoint. */
  readonly valueType?: CanTypeId;
  readonly machine?: FieldMachine;
  readonly required: boolean;
  readonly serverOnly: boolean;
  readonly default?: unknown;
  readonly array?: { readonly required: boolean };
  readonly server?: InterimServerInit;
  readonly nullable?: boolean;
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

/**
 * B5 declared ownership: the artifact's additive `parent`/`scope` members
 * (adopted T28-A containment rule) riding the engine-local `containment`
 * channel beside the frozen intake. `parent` set marks a contained child
 * of that canonical model (local and plain-imported parents enforce
 * identically — flat `{model, id}` linkage); absent `parent` marks a
 * DECLARED root, with `scope: 'app'` for `Model in app` and absent scope
 * for the team-scope default. Absent `containment` itself is the legacy
 * interim posture (hand-built defs predate declared ownership): the
 * pipeline accepts any supplied parent exactly as before.
 *
 * `parent` and `scope` are mutually exclusive: a contained child is
 * parent-scoped, never team- or app-scoped. Team-vs-app carries no
 * pipeline enforcement (rows hold no scope; operation policy is
 * unchanged) — the table records it so joins stay self-describing.
 */
export interface InterimContainment {
  readonly parent?: ModelName;
  readonly scope?: 'app';
}

/**
 * T31 (Rule A): one hook-staged secondary write. Create/set ONLY — staged
 * deletes are barred (pending-source deletion is a forbidden shape and Rule
 * A stages no other-model delete either), and staged writes carry no `when`
 * precondition. The pipeline processes staged writes through the identical
 * per-write path (defaults, required, when/locks/refs, uniques,
 * provisionalize, history) minus CRUD hooks (flat, no cascade), in staging
 * order, immediately after the triggering write provisionalizes.
 */
export type InterimHookStagedWrite =
  | {
      readonly op: 'create';
      readonly model: ModelName;
      readonly id: RecordId;
      readonly parent?: RecordParent;
      readonly data?: Record<string, unknown>;
    }
  | {
      readonly op: 'update';
      readonly model: ModelName;
      readonly id: RecordId;
      readonly data?: Record<string, unknown>;
    };

/**
 * T31 (Rule A): one hook-staged timer replace. Validated like the S6
 * schedule seam (bounded non-empty key, finite `at` >= 0, non-empty event,
 * JSON-safe payload object); cancels carry a key only.
 */
export interface InterimHookSchedule {
  readonly key: string;
  readonly at: number;
  readonly event: OperationName;
  readonly payload: Record<string, unknown>;
}

/**
 * T32b-wire: the transitive fence facility one hook invocation reads
 * through. Hook bodies are transitive effects: they open their OWN fresh
 * scopes (never inherit the trigger's) and re-read CURRENT authority state
 * at their own checkpoints. The pipeline builds this per hook invocation;
 * hook bodies never construct it.
 */
export interface InterimHookTransitive {
  /**
   * The triggering checkpoint's revision — the `triggerRevision` a dispatch
   * claim site passes beside this hook's fresh checkpoint (presenting the
   * trigger's own revision back as the checkpoint is inheriting and is
   * refused). Null when the pipeline ran without a trigger point (direct
   * callers that pass no `trigger`): fresh scopes still open, but no
   * trigger revision is named.
   */
  readonly triggerRevision: Revision | null;
  /** Owner for opened scopes (the trigger owner, else team ?? app). */
  readonly owner: string;
  /**
   * Open a FRESH transitive scope at the CURRENT store revision with zero
   * enrolled dependencies — inheritance is unrepresentable.
   */
  openScope(): Promise<FenceScope>;
  /**
   * Re-read one CURRENT committed row at a transitive scope, enrolling the
   * observed version in that scope (null rows enroll nothing — there is no
   * absent-read dependency; the revision assertion still covers the read).
   * ALWAYS bypasses the pipeline's provisional map: transitive re-reads
   * observe committed authority state, never this batch's uncommitted rows.
   */
  load(scope: FenceScope, model: ModelName, id: RecordId): Promise<StoredRow | null>;
}

/**
 * Hook run context: provisional-before row, caller intent, attribution.
 *
 * T31 (Rule A): `before` is a deep-frozen snapshot — hook mutation attempts
 * throw instead of corrupting the pipeline's lock/ref/unique/history reads.
 * Create/update hooks may `stage` secondary writes and `schedule`/`cancel`
 * timers; all three throw `validation` on remove-op hooks (delete hooks
 * reject by throwing, never stage). Staging to the triggering model is
 * barred (same-model bar: triggering-path recursion AND same-model-via-
 * different-op, pending-source deletion included).
 */
export interface InterimHookContext {
  readonly before: StoredRow | null;
  readonly op: InterimHookOp;
  readonly actor: string;
  readonly now: number;
  /** The hooked (triggering) model; staged writes naming it are rejected. */
  readonly triggerModel: ModelName;
  /**
   * T31: the triggering record id — the pending row's identity, so
   * create/update hooks can parent staged children to it (`before` is null
   * on create, so the id is the only pending handle there).
   */
  readonly triggerId: RecordId;
  /** Stage one secondary write for atomic commit with the trigger. */
  readonly stage: (write: InterimHookStagedWrite) => void;
  /** Stage one timer replace for atomic commit with the trigger. */
  readonly schedule: (op: InterimHookSchedule) => void;
  /** Stage one timer cancel for atomic commit with the trigger. */
  readonly cancel: (key: string) => void;
  /**
   * T32b-wire: transitive fence reads — fresh scopes plus current-state
   * re-reads at those scopes. Built per hook invocation by the pipeline.
   */
  readonly transitive: InterimHookTransitive;
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
 * names, delete behavior, hooks, invariants, locks, and B5 declared
 * ownership. CRUD `by`/`when` live on the CRUD defs (`crud.ts`), not here.
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
  readonly containment?: InterimContainment;
}

/** Validated, frozen model table keyed by model. */
export type ModelTable = ReadonlyMap<ModelName, InterimModelDef>;

/** Build-time dot-path check: non-empty with no empty segments. */
function checkDotPath(path: string, what: string): void {
  if (path === '' || path.split('.').some((segment) => segment === '')) {
    throw new Error(`Invalid ${what} dot path: ${JSON.stringify(path)}`);
  }
}

/**
 * Validate and freeze interim model defs into a lookup table.
 *
 * Throws plain `Error` on programmer bugs: empty/duplicate model names,
 * malformed field names, non-boolean `required`/`serverOnly`, malformed
 * array markers, unserializable or malformed defaults, T18 unknown server
 * inits, `server`+`default` doubles, or non-boolean `nullable`, malformed
 * ref paths or empty ref models, duplicate ref paths, unknown or duplicate
 * unique-key fields, unknown delete modes, malformed B5 containment
 * (non-object, empty parent, non-app scope, parent+scope together),
 * containment cycles over declared parents, malformed
 * hooks/invariants/locks (empty names, dupes, bad ops, non-function
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
      if (Object.hasOwn(field, 'valueType') &&
          (typeof field.valueType !== 'string' || !/^(int|datetime|text|bool|decimal|money|date|duration)(\[\])?\??$/.test(field.valueType) ||
           field.valueType.includes('[]') !== (field.array !== undefined) ||
           Object.hasOwn(field, 'nullable') && field.valueType.endsWith('?') !== field.nullable)) {
        throw new Error(`Invalid valueType for field ${JSON.stringify(name)} on model ${JSON.stringify(model)}: int/datetime/text/bool/decimal/money/date/duration profile must agree with array/nullable markers.`);
      }
      if (field.array !== undefined) {
        const marker = field.array;
        if (
          typeof marker !== 'object' ||
          marker === null ||
          Array.isArray(marker) ||
          typeof marker.required !== 'boolean'
        ) {
          throw new Error(
            `Invalid array marker for field ${JSON.stringify(name)} on model ` +
              `${JSON.stringify(model)}: array markers carry a boolean required.`,
          );
        }
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
      if (field.machine !== undefined) {
        const machine = checkFieldMachine(field.machine);
        if (field.required || field.serverOnly || field.array !== undefined || field.nullable === true ||
            field.server !== undefined || field.default !== machine.initial) {
          throw new Error(`Invalid machine field ${JSON.stringify(name)}: requires an omitted-only literal initial default on a singular nonnullable field.`);
        }
      }
      // T18: closed init set; `server` and `default` are mutually
      // exclusive (source spellings are exclusive too — a hand-built def
      // carrying both is a programmer bug, never a precedence rule).
      if (field.server !== undefined) {
        if (field.server !== 'actor' && field.server !== 'now' && field.server !== 'random_secret') {
          throw new Error(
            `Invalid server init for field ${JSON.stringify(name)} on model ` +
              `${JSON.stringify(model)}: supported: actor, now, random_secret.`,
          );
        }
        if (field.default !== undefined) {
          throw new Error(
            `Invalid field ${JSON.stringify(name)} on model ${JSON.stringify(model)}: ` +
              'server initializers and defaults are mutually exclusive.',
          );
        }
      }
      if (field.nullable !== undefined && typeof field.nullable !== 'boolean') {
        throw new Error(
          `Invalid field ${JSON.stringify(name)} on model ${JSON.stringify(model)}: ` +
            'nullable must be a boolean.',
        );
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
    // B5 declared ownership: shape only here (unknown parent targets
    // terminate the cycle walk below and surface write-time `validation`
    // at the pipeline; the loader rejects dangling generated parents).
    const rawContainment: unknown = def.containment;
    if (rawContainment !== undefined) {
      if (typeof rawContainment !== 'object' || rawContainment === null || Array.isArray(rawContainment)) {
        throw new Error(
          `Invalid containment on model ${JSON.stringify(model)}: containment must be an object.`,
        );
      }
      const declared = rawContainment as { parent?: unknown; scope?: unknown };
      if (declared.parent !== undefined && (typeof declared.parent !== 'string' || declared.parent === '')) {
        throw new Error(
          `Invalid containment on model ${JSON.stringify(model)}: parent must be a non-empty model name.`,
        );
      }
      if (declared.scope !== undefined && declared.scope !== 'app') {
        throw new Error(
          `Invalid containment on model ${JSON.stringify(model)}: scope is "app" when present.`,
        );
      }
      if (declared.parent !== undefined && declared.scope !== undefined) {
        throw new Error(
          `Invalid containment on model ${JSON.stringify(model)}: parent and scope are mutually exclusive.`,
        );
      }
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
    let containment: InterimContainment | undefined;
    try {
      fields = structuredClone(def.fields);
      refs = structuredClone([...def.refs]);
      uniqueKeys = structuredClone([...def.uniqueKeys]);
      whens = def.locks.map((lock) => structuredClone(lock.when));
      containment =
        def.containment === undefined ? undefined : structuredClone({ ...def.containment });
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
        ...(containment !== undefined ? { containment: Object.freeze(containment) } : {}),
      }) as InterimModelDef,
    );
  }
  checkContainmentAcyclic(table);
  return table;
}

/**
 * B5: declared-parent graph must be acyclic (static A4 rejects cycles over
 * the whole-app index, so generated tables never trip this; hand-built
 * tables prove it here). Unknown parent targets terminate the walk —
 * dangling generated parents reject at the loader, and dangling interim
 * parents surface write-time `validation` at the pipeline. Table insertion
 * order decides which cycle reports first; the chain always starts at the
 * revisited model, so the message is deterministic.
 */
function checkContainmentAcyclic(table: Map<ModelName, InterimModelDef>): void {
  const settled = new Set<string>();
  for (const start of table.keys()) {
    const startName = start as string;
    if (settled.has(startName)) {
      continue;
    }
    const path: string[] = [];
    const inPath = new Set<string>();
    let current: string | undefined = startName;
    while (current !== undefined) {
      if (inPath.has(current)) {
        const cycle = [...path.slice(path.indexOf(current)), current];
        throw new Error(
          `Invalid containment on model ${JSON.stringify(current)}: ` +
            `containment cycle ${cycle.join(' -> ')}.`,
        );
      }
      if (settled.has(current)) {
        break;
      }
      inPath.add(current);
      path.push(current);
      const next: ModelName | undefined = table.get(current as ModelName)?.containment?.parent;
      current = next === undefined ? undefined : (next as string);
    }
    for (const name of path) {
      settled.add(name);
    }
  }
}

/** Engine-local attachments for canonical-derived model tables (T04b owns the rest). */
export interface CanonicalModelTableOptions {
  /**
   * Reference paths per model, derived by the descriptor loader from the
   * artifact's singular top-level `ref` field tags. Models without an entry
   * carry no refs. Hooks, invariants, and locks stay engine-local empty in
   * the T16a core scope (T04b extends the contract).
   */
  readonly refs?: ReadonlyMap<ModelName, ReadonlyArray<InterimRefDef>>;
  /**
   * T18 server initializers per model then field (the loader's
   * `serverInits` channel: additive artifact `init` tokens the frozen
   * intake cannot hold). A field listed here resolves its init at
   * creation; fields without an entry resolve nothing. Intake-direct
   * callers (no artifact) omit this and keep the pre-T18 posture.
   */
  readonly serverInits?: ReadonlyMap<ModelName, ReadonlyMap<string, InterimServerInit>>;
  /**
   * T18 known-nullable field names per model (the loader's
   * `nullableFields` channel: additive artifact `nullable` flags).
   * Listed fields fill null when omitted on create (L2 parity);
   * unlisted fields keep the exact prior behavior (absent stays
   * absent — never filled, never rejected).
   */
  readonly nullableFields?: ReadonlyMap<ModelName, ReadonlySet<string>>;
  /**
   * B5 declared ownership per model (the loader's `containment`
   * channel: additive artifact `parent`/`scope` members the frozen
   * intake cannot hold). A present entry — even empty (declared
   * team-scope root) — arms pipeline enforcement for that model;
   * models without an entry keep the legacy interim posture
   * (intake-direct callers omit the channel entirely).
   */
  readonly containment?: ReadonlyMap<ModelName, InterimContainment>;
}

/**
 * T16a: build a validated, frozen model table from canonical model
 * descriptors (the loaded intake's `models`), delegating to `buildModelTable`
 * so enforcement stays in exactly one place.
 *
 * Conversion: `required`/`serverOnly`/array markers map directly; `literal`
 * defaults map to JSON literals, `parent` defaults to `{ parentPath }`
 * lookups; `server` defaults map to NO pipeline `default` — their values
 * resolve from the `serverInits` channel instead (T18 execution; emission
 * marks them non-required, so they never block creates, and `serverOnly`
 * still rejects caller values). `derived` defaults map to nothing: derived
 * fields stay absent from stored rows (L2 drops them from validated output
 * the same way; read-time projection is T04b). Composite unique keys
 * (comma-joined) throw plain `Error` naming T04b: silently dropping a
 * uniqueness constraint would admit duplicates, so the loader rejects such
 * sets first and this guard is unreachable via it. The `containment`
 * channel entries attach verbatim (validated + cycle-checked by
 * `buildModelTable`, like every other def member).
 */
export function buildModelTableFromCanonical(
  models: ReadonlyArray<CanonicalModelDescriptor>,
  opts: CanonicalModelTableOptions = {},
): ModelTable {
  const defs: InterimModelDef[] = [];
  for (const model of models) {
    const fields: Record<string, InterimFieldDef> = {};
    for (const [name, field] of Object.entries(model.fields)) {
      if (Object.hasOwn(field, 'valueType') &&
          (typeof field.valueType !== 'string' || !/^(int|datetime|text|bool|decimal|money|date|duration)(\[\])?\??$/.test(field.valueType) ||
           field.valueType.includes('[]') !== (field.array !== undefined) ||
           Object.hasOwn(field, 'nullable') &&
             (typeof field.nullable !== 'boolean' || field.valueType.endsWith('?') !== field.nullable))) {
        throw new Error(`Invalid valueType for field ${JSON.stringify(name)} on model ${JSON.stringify(model.name)}: int/datetime/text/bool/decimal/money/date/duration profile must agree with array/nullable markers.`);
      }

      let fallback: unknown;
      let hasFallback = false;
      const canonicalDefault = field.default;
      if (canonicalDefault !== undefined) {
        if (canonicalDefault.kind === 'literal') {
          try {
            fallback = structuredClone(canonicalDefault.value);
          } catch {
            throw new Error(
              `Invalid literal default for field ${JSON.stringify(name)} on model ` +
                `${JSON.stringify(model.name as string)}: defaults must be serializable data.`,
            );
          }
          hasFallback = true;
        } else if (canonicalDefault.kind === 'parent') {
          fallback = { parentPath: canonicalDefault.path };
          hasFallback = true;
        }
        // `server`/`derived`: no pipeline default (T18 execution); the
        // descriptor's `serverOnly` still rejects caller-supplied values.
      }
      const serverInit = opts.serverInits?.get(model.name)?.get(name);
      const knownNullable = opts.nullableFields?.get(model.name)?.has(name) === true;
      fields[name] = {
        ...(Object.hasOwn(field, 'valueType') ? { valueType: field.valueType! } : {}),
        required: field.required,
        serverOnly: field.serverOnly,
        ...(hasFallback ? { default: fallback } : {}),
        ...(field.machine !== undefined ? { machine: checkFieldMachine(field.machine) } : {}),
        ...(field.array !== undefined ? { array: { required: field.array.required } } : {}),
        ...(serverInit !== undefined ? { server: serverInit } : {}),
        ...(knownNullable ? { nullable: true } : {}),
      };
    }
    const uniqueKeys = model.uniqueKeys ?? [];
    for (const key of uniqueKeys) {
      if (key.includes(',')) {
        throw new Error(
          `Model ${JSON.stringify(model.name as string)} declares composite unique ` +
            `${JSON.stringify(key)}; composite uniques need T04b and cannot load in the ` +
            'T16a core scope.',
        );
      }
    }
    const containment = opts.containment?.get(model.name);
    defs.push({
      model: model.name,
      fields,
      refs: [...(opts.refs?.get(model.name) ?? [])],
      uniqueKeys: [...uniqueKeys],
      deleteMode: model.deleteMode,
      hooks: [],
      invariants: [],
      locks: [],
      ...(containment !== undefined ? { containment: { ...containment } } : {}),
    });
  }
  return buildModelTable(defs);
}
