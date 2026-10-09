/**
 * Lane 03 S5: mutation write pipeline (provisional writes, uniques, history).
 *
 * `runMutationWrites` evaluates an ordered batch of create/update/remove
 * writes against a provisional map layered over the store, returning the
 * fenced-commit inputs (domain writes, history, unique claims/releases,
 * hook-staged schedules) plus receipt `resolvedDefaults`. It commits
 * nothing itself; callers commit the result with the admission fence. All
 * decisions below are the S5 spec, documented inline; T31 adds Rule A flat
 * hook staging (create/update hooks stage secondary writes + timers into
 * the same batch, same-model barred, no hook reentry).
 */

import { deepFreeze, getDataPath } from '../internal/own-data.js';
import { encodeValue, validateValue } from '@canlang/values';
import type {
  CanTypeId,
  DomainWrite,
  HistoryEntry,
  InvocationContext,
  ModelName,
  OperationName,
  QueryPredicate,
  RecordId,
  RecordParent,
  RecordVersion,
  Revision,
  ScheduleOp,
  StoredRow,
  UniqueClaim,
  UniqueRelease,
} from '@canlang/contracts';
import type { StoragePort } from '../storage/port.js';
import { StateError } from '../errors.js';
import { openTransitiveScope, type FenceScope } from '../invocation/admission.js';
import { STAGING_MAX_ID_LENGTH } from '../effects/staging.js';
import { checkJsonSafe as checkJsonEncoding, jsonClone } from '../internal/json.js';
import { evalPredicateForRow, resolveRowPath } from '../policy/grants.js';
import {
  isParentPathDefault,
  getModelFieldConstraint,
  type InterimHookContext,
  type InterimHookSchedule,
  type InterimHookStagedWrite,
  type InterimModelDef,
  type InterimServerInit,
  type ModelTable,
} from './models.js';

/**
 * One caller write. `data` is create data or an update patch (`undefined`
 * reads as `{}`); `parent` is create-only (update/remove carrying one is
 * rejected: parent linkage is immutable); `when` is an optional candidate
 * precondition supplied by the CRUD defs.
 */
export interface MutationWrite {
  readonly transition?: { readonly field: string; readonly from: string; readonly to: string };
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
  /**
   * Optional language-to-wire conversion supplied by the runtime/Values
   * owner. Only present fields with a checked valueType use this checkpoint,
   * after defaults, hooks and required checks, before JSON validation.
   * Missing metadata or an absent codec preserves the existing wire path.
   */
  readonly encodeField?: (type: CanTypeId, value: unknown) => unknown;
  /**
   * T32b-wire: the triggering checkpoint POINT (revision + owner only).
   * Hook bodies read it as `transitive.triggerRevision` (the
   * `triggerRevision` a dispatch claim site passes beside their fresh
   * checkpoint) and open scopes under its owner. The trigger's enrolled
   * DEPENDENCIES never cross this boundary — hooks inherit nothing; every
   * transitive read opens a fresh scope and enrolls its own reads. Absent
   * on direct pipeline calls (including the CRUD executors, which thread
   * no trigger yet): `triggerRevision` reads null and the owner falls
   * back to team ?? app, mirroring admission.
   */
  readonly trigger?: { readonly revision: Revision; readonly owner: string };
  /**
   * B1: gate update/remove writes against archived targets with the
   * EXACT admission rule (`validation` / `Archived records cannot be
   * used here.`). The CRUD executors get this gate from admission
   * (admission loads every ref and rejects archived targets before
   * execution); scenario-staged writes bypass per-write admission, so
   * the scenario seam passes `true` for CRUD/scenario parity. Absent
   * reads as false: privileged direct callers (migrations/backfill)
   * may legitimately touch archived rows.
   */
  readonly gateArchivedTargets?: boolean;
}

/**
 * Pipeline output: fenced-commit inputs plus receipt defaults.
 *
 * B1: `resolvedDefaults` is flat per batch. Same-named defaulted fields
 * across writes in one batch are REJECTED LOUD (`validation`, before
 * anything commits) instead of last-wins: a flat receipt cannot
 * attribute two resolutions of one name, so colliding batches never
 * persist silently. Single-write callers (both CRUD executors, the
 * scenario seam's one-write calls, fanout children) cannot collide;
 * the seam keys its per-call maps itself (`<callIndex>:<model>.<field>`).
 * If a live caller ever needs two resolutions of one name in one batch,
 * per-write receipt keying is a contract item (T04b/I00), not a silent
 * pipeline change.
 */
export interface MutationWritesResult {
  readonly writes: DomainWrite[];
  readonly history: HistoryEntry[];
  readonly uniqueClaims: UniqueClaim[];
  readonly uniqueReleases: UniqueRelease[];
  readonly resolvedDefaults: Record<string, unknown>;
  /**
   * T31 (Rule A): hook-staged timer ops in staging order, for the same
   * fenced batch. Empty when no hook staged timers.
   */
  readonly schedules: ScheduleOp[];
}

/** Provisional entry: a staged row, or a removal masking the store. */
type ProvisionalEntry =
  | { readonly status: 'row'; readonly row: StoredRow }
  | { readonly status: 'removed' };

/**
 * T31 (Rule A): one hook-staged secondary write plus its staging hook's
 * name for failure attribution. Runs through the identical per-write path
 * as caller writes, minus CRUD hooks (flat, no cascade).
 */
interface StagedWriteEntry {
  readonly write: MutationWrite;
  readonly hook: string;
}

/**
 * T31 (Rule A): work-queue entry. Caller writes carry `stagedBy: null` and
 * run hooks; staged writes carry their staging hook's name and skip hooks
 * while sharing every other check (defaults, required, when/locks/refs,
 * uniques, provisionalize, history).
 */
interface MutationQueueEntry {
  readonly write: MutationWrite;
  readonly stagedBy: string | null;
}

/** T31 (Rule A): per-trigger-write sink for hook-staged writes + timers. */
interface StagingSink {
  readonly writes: StagedWriteEntry[];
  readonly schedules: ScheduleOp[];
}

function keyOf(model: ModelName, id: RecordId): string {
  return `${model as string}\0${id as string}`;
}

/** History/row actor attribution for a context (S5: `test` kinds sign `test`). */
function actorFor(context: InvocationContext): string {
  return (
    context.actor?.userId ?? (context.kind === 'test' ? 'test' : (context.trustedSource ?? 'public'))
  );
}

/**
 * T18: resolve one closed-set server initializer (creation only, omitted
 * fields only — `serverOnly` rejects every caller-supplied value, so
 * these fields always arrive omitted). `actor` stamps the row's own
 * attribution identity as a wire `{id}` user value; `now` stamps the
 * frozen invocation clock (retry- and replay-stable: fence retries
 * re-execute pre-commit, while replays return the committed row instead
 * of re-evaluating); `random_secret` mints 256-bit opaque hex material
 * per execution — stable per COMMITTED operation identity through that
 * same replay path (the receipt records it; a retry that re-executes
 * has committed nothing yet). Randomness comes from the ambient
 * `globalThis.crypto` port (node and workerd both provide it — the same
 * seam `replay.ts` hashes with).
 */
function evalServerInit(
  init: InterimServerInit,
  now: number,
  actor: string,
): unknown {
  if (init === 'actor') {
    return { id: actor };
  }
  if (init === 'now') {
    if (!Number.isFinite(now)) {
      throw new Error('Mutation pipeline needs a finite context.now to resolve server=now.');
    }
    return new Date(now).toISOString();
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
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
 * T31 (Rule A): create/update hooks may stage secondary writes
 * (create/set on other models, same-model barred) plus schedule/cancel
 * timer ops. Staged writes join the work queue immediately after their
 * trigger in staging order and run the identical per-write path minus CRUD
 * hooks (flat, no cascade); hooks evaluate once, in written order, against
 * the proposed state. Staged writes observe the trigger's provisional row
 * (pending parents resolve) plus earlier staged rows, reserve their own
 * versions, enroll in the same fence via the single batch commit, and
 * record history under the triggering operation's identity. Any staged
 * failure voids the whole batch before commit (atomic rollback).
 *
 * B1: same-batch self-canceling writes (create+remove, update+remove one
 * id) net their uniques in the pipeline: a hard remove drops every claim
 * the batch staged for its record and releases the first-touch
 * (committed) keys, so no claim dangles on a removed row and no
 * committed claim strands. (Same-batch double-touch of one row — e.g. a
 * staged update to a staged create — still fails at commit: adapters
 * pre-check every expectedVersion against stored state, so chained
 * provisional versions conflict. Staged writes inherit exactly the
 * caller multi-write rule.)
 */
export async function runMutationWrites(input: MutationWritesInput): Promise<MutationWritesResult> {
  const { table, writes, context, store } = input;
  const now = context.now;
  const actor = actorFor(context);
  // T32b-wire: the transitive facility's trigger point. Revision + owner
  // ONLY — the trigger's enrolled dependencies never enter the pipeline,
  // so hook bodies cannot inherit them. Without a trigger the owner falls
  // back to team ?? app, mirroring admission's checkpoint owner.
  const transitiveTriggerRevision = input.trigger?.revision ?? null;
  const transitiveOwner = input.trigger?.owner ?? context.team?.teamId ?? context.app;
  const provisional = new Map<string, ProvisionalEntry>();
  const outWrites: DomainWrite[] = [];
  const outHistory: HistoryEntry[] = [];
  const outClaims: UniqueClaim[] = [];
  const outReleases: UniqueRelease[] = [];
  const resolvedDefaults: Record<string, unknown> = {};
  const outSchedules: ScheduleOp[] = [];
  const touchedDefs: InterimModelDef[] = [];
  /**
   * B1: first-touch before-rows per record (committed state at batch
   * start, or null for batch-created rows). Hard removes release unique
   * keys from the FIRST touch — not the provisional before — so
   * multi-touch batches (update+remove, create+remove) free exactly the
   * committed keys and never claim-then-dangle.
   */
  const firstBefore = new Map<string, StoredRow | null>();
  /**
   * B1: resolved-default attribution per batch (field name to the tag
   * of the write that first resolved it). A second write resolving the
   * same name rejects LOUD — flat receipts cannot attribute two
   * resolutions of one name.
   */
  const defaultWriters = new Map<string, string>();
  /** B1: monotonic per-write tag counter (queue indices shift on splice). */
  let processedWrites = 0;

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
      if (fieldDef.machine !== undefined) {
        throw new StateError('validation', `Machine field ${JSON.stringify(field)} can only be changed by transition.`);
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
   * The runtime converts checked fields at this post-hook checkpoint;
   * State still owns every earlier structural/presence verdict. Untyped
   * bigints and circular refs keep the existing JSON-safety rejection.
   */
  const checkJsonSafe = (
    candidate: Record<string, unknown>,
    def: InterimModelDef,
    defaultWriter?: string,
    constrainedFields?: ReadonlySet<string>,
    encodedFields?: ReadonlySet<string>,
  ): void => {
    normalizeConstraints(candidate, def, constrainedFields ?? new Set(Object.keys(candidate)));
    if (input.encodeField !== undefined) {
      for (const [field, value] of Object.entries(candidate)) {
        if (encodedFields !== undefined && !encodedFields.has(field)) continue;
        const type = def.fields[field]?.valueType;
        if (type !== undefined && value !== undefined) {
          safeSet(candidate, field, jsonClone(input.encodeField(type, value), `Field ${JSON.stringify(field)}`));
        }
      }
    }
    try {
      JSON.stringify(candidate);
    } catch {
      throw new StateError(
        'validation',
        `Candidate for model ${JSON.stringify(def.model as string)} holds non-JSON values.`,
      );
    }
    if (input.encodeField !== undefined && defaultWriter !== undefined) {
      // Receipts retain the original resolved default, which may differ
      // from the post-hook field. Reuse its existing write attribution.
      for (const [field, fieldDef] of Object.entries(def.fields)) {
        if (defaultWriters.get(field) !== defaultWriter) continue;
        const value = resolvedDefaults[field];
        if (fieldDef.valueType !== undefined && value !== undefined) {
          safeSet(resolvedDefaults, field, jsonClone(
            input.encodeField(fieldDef.valueType, value), `Resolved default ${JSON.stringify(field)}`,
          ));
        }
        checkJsonEncoding(resolvedDefaults[field], `Resolved default ${JSON.stringify(field)}`);
      }
    }
  };

  /** Values owns wire decoding, Unicode trim, and inclusive field bounds. */
  const normalizeConstraints = (
    candidate: Record<string, unknown>, def: InterimModelDef,
    selected: ReadonlySet<string>, defaultWriter?: string,
  ): void => {
    for (const field of selected) {
      if (!Object.hasOwn(candidate, field)) continue;
      const fieldDef = def.fields[field];
      if (fieldDef === undefined) continue;
      const constraint = getModelFieldConstraint(fieldDef);
      if (constraint === undefined || fieldDef.valueType === undefined) continue;
      const value = candidate[field];
      if (value === undefined || value === null) continue;
      try {
        const wire = input.encodeField?.(fieldDef.valueType, value) ?? value;
        const normalized = validateValue(constraint.schema, constraint.type, { value: wire }, 'create') as Readonly<Record<string, unknown>>;
        // Bounds validate through Values' wire view without replacing native
        // hook inputs. Only trim changes the value here; encoding still belongs
        // to the existing post-hook checkpoint (including resolved defaults).
        const constrained = fieldDef.trim === true
          ? encodeValue(fieldDef.valueType, normalized['value'] as Parameters<typeof encodeValue>[1])
          : value;
        safeSet(candidate, field, jsonClone(constrained, `Field ${JSON.stringify(field)}`));
        if (defaultWriter !== undefined && defaultWriters.get(field) === defaultWriter) {
          safeSet(resolvedDefaults, field, jsonClone(constrained, `Resolved default ${JSON.stringify(field)}`));
        }
      } catch (error) {
        throw new StateError('validation', `Invalid field ${JSON.stringify(field)} on model ${JSON.stringify(def.model as string)}: ${String(error)}`);
      }
    }
  };

  /**
   * T31 (Rule A) stage-time validation for one hook-staged write: shape,
   * create/set-only (staged deletes barred), known model (programmer bug
   * otherwise, mirroring the pipeline's unknown-model rule), and the
   * same-model bar — triggering-path recursion, same-model-via-different-op,
   * and pending-source deletion all name the trigger model, so one bar
   * covers all three. Returns an engine-owned queue entry. State-dependent
   * checks (refs, locks, uniques, versions) run later on the shared
   * per-write path, attributed to the staging hook via the queue entry.
   */
  const checkStagedWrite = (
    def: InterimModelDef,
    hookName: string,
    staged: InterimHookStagedWrite,
  ): StagedWriteEntry => {
    const hookTag =
      `Hook ${JSON.stringify(hookName)} on model ${JSON.stringify(def.model as string)}`;
    if (typeof staged !== 'object' || staged === null || Array.isArray(staged)) {
      throw new StateError('validation', `${hookTag} staged a write that must be an object.`);
    }
    if (Object.hasOwn(staged, 'transition')) {
      throw new StateError('validation', `${hookTag} cannot stage transitions.`);
    }
    const stagedOp: unknown = (staged as { readonly op?: unknown }).op;
    if (stagedOp !== 'create' && stagedOp !== 'update') {
      throw new StateError(
        'validation',
        `${hookTag} cannot stage ${JSON.stringify(stagedOp)} writes; hooks stage create/set only.`,
      );
    }
    // Validated above: only create/set stage.
    const op = stagedOp as 'create' | 'update';
    const stagedModel: unknown = (staged as { readonly model?: unknown }).model;
    if (typeof stagedModel !== 'string' || stagedModel === '') {
      throw new StateError('validation', `${hookTag} staged a write with no model.`);
    }
    if (!table.has(stagedModel as ModelName)) {
      throw new Error(`${hookTag} staged a write to unknown model ${JSON.stringify(stagedModel)}.`);
    }
    if (stagedModel === (def.model as string)) {
      throw new StateError(
        'validation',
        `${hookTag} cannot stage same-model writes; got ${JSON.stringify(op)} on ` +
          `${JSON.stringify(stagedModel)} (triggering-path recursion and pending-source ` +
          'deletion are barred).',
      );
    }
    const stagedId: unknown = (staged as { readonly id?: unknown }).id;
    if (typeof stagedId !== 'string' || stagedId === '') {
      throw new StateError(
        'validation',
        `${hookTag} staged a write needing a non-empty string record id.`,
      );
    }
    const stagedData: unknown = (staged as { readonly data?: unknown }).data;
    if (
      stagedData !== undefined &&
      (typeof stagedData !== 'object' || stagedData === null || Array.isArray(stagedData))
    ) {
      throw new StateError(
        'validation',
        `${hookTag} staged a write whose data must be an object.`,
      );
    }
    const stagedParent: unknown = (staged as { readonly parent?: unknown }).parent;
    let parent: RecordParent | undefined;
    if (stagedParent !== undefined) {
      if (op !== 'create') {
        throw new StateError(
          'validation',
          `${hookTag} staged an update carrying a parent; parent linkage is immutable.`,
        );
      }
      if (
        typeof stagedParent !== 'object' ||
        stagedParent === null ||
        Array.isArray(stagedParent)
      ) {
        throw new StateError(
          'validation',
          `${hookTag} staged a write with an invalid parent reference.`,
        );
      }
      const parentRecord = stagedParent as Record<string, unknown>;
      const parentModel: unknown = parentRecord['model'];
      const parentId: unknown = parentRecord['id'];
      if (
        typeof parentModel !== 'string' ||
        parentModel === '' ||
        typeof parentId !== 'string' ||
        parentId === ''
      ) {
        throw new StateError(
          'validation',
          `${hookTag} staged a write with an invalid parent reference.`,
        );
      }
      parent = { model: parentModel as ModelName, id: parentId as RecordId };
    }
    return {
      hook: hookName,
      write: {
        op,
        model: stagedModel as ModelName,
        id: stagedId as RecordId,
        ...(parent !== undefined ? { parent } : {}),
        ...(stagedData !== undefined
          ? { data: jsonClone(stagedData as Record<string, unknown>, `${hookTag} staged data`) }
          : {}),
      },
    };
  };

  /**
   * T31 (Rule A) stage-time validation for one hook-staged timer replace:
   * the S6 schedule shape (bounded non-empty key, finite `at` >= 0,
   * non-empty event, JSON-safe payload object), attributed to the staging
   * hook. The invoke boundary re-validates before commit (defense in depth).
   */
  const checkStagedSchedule = (
    def: InterimModelDef,
    hookName: string,
    replacement: InterimHookSchedule,
  ): ScheduleOp => {
    const hookTag =
      `Hook ${JSON.stringify(hookName)} on model ${JSON.stringify(def.model as string)}`;
    if (
      typeof replacement !== 'object' ||
      replacement === null ||
      Array.isArray(replacement)
    ) {
      throw new StateError('validation', `${hookTag} staged a schedule that must be an object.`);
    }
    const raw = replacement as unknown as Record<string, unknown>;
    const key: unknown = raw['key'];
    if (typeof key !== 'string' || key === '') {
      throw new StateError('validation', `${hookTag} staged a schedule with no key.`);
    }
    if (key.length > STAGING_MAX_ID_LENGTH) {
      throw new StateError(
        'validation',
        `${hookTag} staged a schedule key exceeding ${STAGING_MAX_ID_LENGTH} characters.`,
      );
    }
    const at: unknown = raw['at'];
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
      throw new StateError(
        'validation',
        `${hookTag} staged a schedule with an invalid time; want a finite number >= 0.`,
      );
    }
    const event: unknown = raw['event'];
    if (typeof event !== 'string' || event === '') {
      throw new StateError('validation', `${hookTag} staged a schedule with no event.`);
    }
    const payload: unknown = raw['payload'];
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new StateError(
        'validation',
        `${hookTag} staged a schedule whose payload must be an object.`,
      );
    }
    const cloned = jsonClone(
      payload as Record<string, unknown>,
      `${hookTag} staged schedule payload`,
    );
    checkJsonEncoding(cloned, `${hookTag} staged schedule payload`);
    return { op: 'replace', key, at, event: event as OperationName, payload: cloned };
  };

  /** T31 (Rule A) stage-time validation for one hook-staged timer cancel. */
  const checkStagedCancel = (
    def: InterimModelDef,
    hookName: string,
    key: string,
  ): ScheduleOp => {
    const hookTag =
      `Hook ${JSON.stringify(hookName)} on model ${JSON.stringify(def.model as string)}`;
    if (typeof key !== 'string' || key === '') {
      throw new StateError('validation', `${hookTag} staged a cancel with no key.`);
    }
    if (key.length > STAGING_MAX_ID_LENGTH) {
      throw new StateError(
        'validation',
        `${hookTag} staged a cancel key exceeding ${STAGING_MAX_ID_LENGTH} characters.`,
      );
    }
    return { op: 'cancel', key };
  };

  /**
   * Run matching hooks in written order; each gets a clone, returns next.
   * T31 (Rule A): each hook also gets a staging context — `before` is a
   * deep-frozen snapshot (mutation attempts throw), and `stage`/`schedule`/
   * `cancel` collect into `sink` (all three reject on remove-op hooks:
   * delete hooks reject by throwing, never stage). Hook bodies evaluate
   * once, in written order, against the proposed state.
   */
  const runHooks = async (
    def: InterimModelDef,
    op: 'create' | 'update' | 'remove',
    candidate: Record<string, unknown>,
    before: StoredRow | null,
    triggerId: RecordId,
    sink: StagingSink,
  ): Promise<Record<string, unknown>> => {
    let current = candidate;
    // Frozen once per op and shared across hooks in written order: no hook
    // can mutate the snapshot a later hook (or the pipeline's own
    // lock/ref/unique/history reads) observes.
    const frozenBefore = before === null ? null : deepFreeze(jsonClone(before, 'Hook before'));
    for (const hook of def.hooks) {
      if (!hook.ops.includes(op)) {
        continue;
      }
      const hookTag =
        `Hook ${JSON.stringify(hook.name)} on model ${JSON.stringify(def.model as string)}`;
      const forbidStagingOnRemove = (what: string): void => {
        if (op === 'remove') {
          throw new StateError(
            'validation',
            `${hookTag} runs on a delete and cannot stage ${what}; only create/update hooks stage.`,
          );
        }
      };
      const ctx: InterimHookContext = {
        before: frozenBefore,
        op,
        actor,
        now,
        triggerModel: def.model,
        triggerId,
        stage: (staged) => {
          forbidStagingOnRemove('secondary writes');
          sink.writes.push(checkStagedWrite(def, hook.name, staged));
        },
        schedule: (replacement) => {
          forbidStagingOnRemove('timers');
          sink.schedules.push(checkStagedSchedule(def, hook.name, replacement));
        },
        cancel: (key) => {
          forbidStagingOnRemove('timers');
          sink.schedules.push(checkStagedCancel(def, hook.name, key));
        },
        // T32b-wire: hook bodies are transitive effects — fresh scopes at
        // the CURRENT revision (zero inherited deps) plus re-reads of
        // CURRENT committed rows at those scopes. `load` deliberately
        // bypasses the provisional map (`store.load`, never `getRow`):
        // transitive re-reads observe committed authority state, never
        // this batch's uncommitted rows.
        transitive: {
          triggerRevision: transitiveTriggerRevision,
          owner: transitiveOwner,
          openScope: () => openTransitiveScope(store, transitiveOwner),
          load: async (
            scope: FenceScope,
            model: ModelName,
            id: RecordId,
          ): Promise<StoredRow | null> => {
            const row = await store.load(model, id);
            if (row !== null) {
              scope.enroll({ kind: 'record', model, id, version: row.version });
            }
            return row;
          },
        },
      };
      // Each hook gets a clone and its return is re-cloned: hooks can neither
      // mutate the pipeline candidate nor smuggle uncloneable values forward
      // (or retain an alias and mutate it after returning).
      const next = await hook.run(jsonClone(current, 'Hook candidate'), ctx);
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        throw new Error(`${hookTag} must return a candidate object.`);
      }
      const checked = jsonClone(next as Record<string, unknown>, 'Hook result');
      for (const [field, fieldDef] of Object.entries(def.fields)) {
        if (fieldDef.machine !== undefined && checked[field] !== current[field]) {
          throw new StateError('validation', `${hookTag} cannot change machine field ${JSON.stringify(field)}.`);
        }
      }
      current = checked;
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
      if (value === null && !ref.field.includes('.') && Object.hasOwn(def.fields, ref.field) &&
        Object.hasOwn(def.fields[ref.field]!, 'nullable') &&
        def.fields[ref.field]?.nullable === true && def.fields[ref.field]?.array === undefined) {
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

  /**
   * B1: record one resolved default under the flat batch receipt map,
   * rejecting LOUD when another write already resolved the same name.
   * `tag` identifies the resolving write (op + model + id + sequence).
   * Same-write double recording is impossible (the create path visits
   * each field once), so any second tag is a genuine cross-write
   * collision — last-wins would persist silently without this throw.
   */
  const recordDefault = (field: string, value: unknown, tag: string): void => {
    const first = defaultWriters.get(field);
    if (first !== undefined && first !== tag) {
      throw new StateError(
        'validation',
        `Resolved-default collision in one mutation batch: field ${JSON.stringify(field)} ` +
          `defaulted by both ${first} and ${tag}; receipts record resolved defaults once ` +
          'per batch, so split the batch or rename the field.',
      );
    }
    defaultWriters.set(field, tag);
    safeSet(resolvedDefaults, field, value);
  };

  /**
   * B1: scenario-parity archived-target gate. Code and message are EXACTLY
   * admission's (`validation` / `Archived records cannot be used here.`):
   * the CRUD executors inherit this verdict from admission, and gated
   * pipeline callers (the scenario seam) must agree with it verdict for
   * verdict. Runs before hooks — admission gates before execution too.
   */
  const checkGatedArchivedTarget = (before: StoredRow, gateOn: boolean): void => {
    if (gateOn && before.archivedAt !== null) {
      throw new StateError('validation', 'Archived records cannot be used here.');
    }
  };

  // T31 (Rule A): the work queue starts as the caller writes; each
  // trigger write's staged secondaries splice in immediately after it, in
  // staging order, so staged writes observe the trigger's provisional row
  // (pending parents resolve) plus earlier staged rows. Staged entries skip
  // hooks (flat, no cascade) and stage nothing further.
  const queue: MutationQueueEntry[] = writes.map((write) => ({ write, stagedBy: null }));
  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index];
    if (entry === undefined) {
      throw new Error('Mutation queue misaligned.');
    }
    const write = entry.write;
    // Null for caller writes (hooks run into `sink`); the staging hook's
    // name for staged writes (hooks skipped, sink stays empty).
    const stagedBy = entry.stagedBy;
    const sink: StagingSink = { writes: [], schedules: [] };
    /** Drain this write's staged secondaries into the queue + schedules. */
    const drainSink = (): void => {
      if (sink.writes.length === 0 && sink.schedules.length === 0) {
        return;
      }
      queue.splice(
        index + 1,
        0,
        ...sink.writes.map(
          (staged): MutationQueueEntry => ({ write: staged.write, stagedBy: staged.hook }),
        ),
      );
      outSchedules.push(...sink.schedules);
    };
    if (write.transition !== undefined && (write.op !== 'update' || stagedBy !== null)) {
      throw new StateError('validation', 'Transition is available only on explicit scenario updates.');
    }
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
    if (before !== null) {
      for (const [field, fieldDef] of Object.entries(def.fields)) {
        if (fieldDef.machine !== undefined && !fieldDef.machine.states.includes(before.data[field] as string)) {
          throw new StateError('validation', `Stored machine state for ${JSON.stringify(field)} is incompatible; migration is required.`);
        }
      }
    }
    // B1: first-touch before-row (committed state at batch start; null for
    // batch-created rows). Captured once per record: later touches see
    // provisional state, but unique-netting needs the committed keys.
    const rowKey = keyOf(write.model, id);
    if (!firstBefore.has(rowKey)) {
      firstBefore.set(rowKey, before);
    }
    // B1: collision-guard tag for this write (monotonic sequence — queue
    // indices shift when staged writes splice in).
    processedWrites += 1;
    const writeTag =
      `${write.op} ${write.model as string} ${id as string} (batch write #${processedWrites})`;

    // T18/R27 ADOPTED RULE (one rule over creation defaults, server
    // initialization, updates, and hooks): server-owned fields resolve
    // in the engine at creation (closed init set, omitted-only, before
    // hooks) and are excluded from every caller input; the ordinary
    // update path rejects them (checker E3001 at authoring, `serverOnly`
    // at admission/execution); ONLY hook adjustment of the pending
    // record (`set event.after`, DESIGN §518) may rewrite them; replay
    // never re-evaluates (the committed row is returned). Re-anchoring a
    // COMMITTED server-owned field from an operation body stays rejected
    // (checker-pinned); a supported re-anchor mechanism is future work.
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
      // B5 declared ownership (adopted T28-A): a declared child REQUIRES
      // its declared parent model; a declared root rejects any supplied
      // parent. Undeclared (legacy interim) defs skip this entirely —
      // exact prior behavior. Local and plain-imported parents enforce
      // identically (flat linkage); every caller path (CRUD, scenario
      // staging, hook-staged writes) shares this block, so they agree.
      const declared = def.containment;
      if (declared !== undefined) {
        if (declared.parent !== undefined) {
          if (write.parent === undefined) {
            throw new StateError(
              'validation',
              `Missing required parent for model ${JSON.stringify(write.model as string)}.`,
            );
          }
          if ((write.parent.model as string) !== (declared.parent as string)) {
            throw new StateError(
              'validation',
              `Invalid parent for model ${JSON.stringify(write.model as string)}: ` +
                `expected parent model ${JSON.stringify(declared.parent as string)}.`,
            );
          }
        } else if (write.parent !== undefined) {
          throw new StateError(
            'validation',
            `Parent linkage is not allowed for model ${JSON.stringify(write.model as string)}.`,
          );
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
      // T18 creation evaluation order per omitted field: caller data
      // (above) wins over everything; then literal defaults, parent-path
      // defaults, required-array rejection, known-nullable null-fill
      // (L2 parity: nullable arrays yield null, so this precedes the
      // array-empty fill), ordinary-array omit-to-empty, and finally
      // closed-set server initializers — hooks observe all of it.
      for (const [field, fieldDef] of Object.entries(def.fields)) {
        if (Object.hasOwn(candidate, field)) {
          continue;
        }
        const fallback = fieldDef.default;
        if (fallback !== undefined) {
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
            recordDefault(field, structuredClone(resolved), writeTag);
          } else {
            safeSet(candidate, field, structuredClone(fallback));
            recordDefault(field, structuredClone(fallback), writeTag);
          }
          continue;
        }
        // No default: required-array omission rejects (L2 required-first
        // agreement — emission marks these required, so the verdict below
        // would match; failing here keeps the T16a message stable).
        const marker = fieldDef.array;
        if (marker?.required === true) {
          throw new StateError('validation', `Missing required field ${JSON.stringify(field)}.`);
        }
        // T18: known-nullable fills null (L2 parity); unknown nullability
        // (hand-built defs, fixtures) skips with prior behavior intact.
        if (fieldDef.nullable === true) {
          safeSet(candidate, field, null);
          recordDefault(field, null, writeTag);
          continue;
        }
        // T16a: the T09 array marker decides. Ordinary arrays omit to `[]`
        // (recorded like any resolved omission-fill). Explicit defaults
        // (handled above) always win over omit-to-empty.
        if (marker !== undefined) {
          safeSet(candidate, field, []);
          recordDefault(field, [], writeTag);
          continue;
        }
        // T18: closed-set server init, the last prep step before hooks.
        // Unspecified inits (pre-T18 artifacts, intake-direct tables)
        // resolve nothing — the field stays missing, never invented.
        const init = fieldDef.server;
        if (init !== undefined) {
          const resolved = evalServerInit(init, now, actor);
          safeSet(candidate, field, resolved);
          recordDefault(field, resolved, writeTag);
        }
      }
      checkRequired(candidate, def);
      normalizeConstraints(candidate, def, new Set(Object.keys(candidate)), writeTag);
      // T31 (Rule A): staged writes skip hooks (flat, no cascade); every
      // check below plus locks and end-of-batch invariants still runs.
      const hooked =
        stagedBy !== null
          ? candidate
          : await runHooks(def, 'create', candidate, null, id, sink);
      // Hooks are trusted otherwise (adopted R27 rule: hooks adjusting
      // the pending record are the ONLY writers that may set server-only
      // fields), but the contract checks re-run: no undeclared fields,
      // required present, JSON-safe values.
      checkKnownFields(hooked, def);
      checkRequired(hooked, def);
      checkJsonSafe(hooked, def, writeTag);
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
      drainSink();
      continue;
    }

    if (write.op === 'update') {
      if (before === null) {
        throw new StateError('not_found', 'Record not found.');
      }
      // B1: archived rows stay updatable here BY DESIGN unless the caller
      // opts into the admission-parity gate: canonical admission gates
      // archived targets for every invoke-path write (CRUD via admission,
      // scenarios via `gateArchivedTargets`), while privileged direct
      // callers (migrations/backfill) may legitimately touch archived rows.
      checkGatedArchivedTarget(before, input.gateArchivedTargets === true);
      if (write.parent !== undefined) {
        throw new StateError('validation', 'Parent linkage is immutable.');
      }
      const candidate: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(before.data)) {
        safeSet(candidate, field, structuredClone(value));
      }
      // Updates apply NO defaults: only the patch lands on before.data.
      applyCallerData(candidate, asDataObject(write.data, 'Update patch'), def);
      if (write.transition !== undefined) {
        const edge = write.transition;
        if (typeof edge !== 'object' || edge === null || Array.isArray(edge) ||
            typeof edge.field !== 'string' || typeof edge.from !== 'string' || typeof edge.to !== 'string') {
          throw new StateError('validation', 'Malformed transition.');
        }
        if (write.data !== undefined && Object.hasOwn(write.data, edge.field)) {
          throw new StateError('validation', 'Transition cannot carry a patch for its machine field.');
        }
        const machine = def.fields[edge.field]?.machine;
        if (machine === undefined || !machine.transitions.some((site) =>
            site.from === edge.from && site.to === edge.to && site.operation === context.operation)) {
          throw new StateError('validation', 'Transition is not declared for the current operation.');
        }
        if (!machine.states.includes(before.data[edge.field] as string)) {
          throw new StateError('validation', 'Stored machine state is incompatible with its declaration.');
        }
        if (before.data[edge.field] !== edge.from) {
          throw new StateError('rule_failed', 'Transition source state does not match.');
        }
        safeSet(candidate, edge.field, edge.to);
      }
      checkRequired(candidate, def);
      const changedFields = new Set(Object.keys(write.data ?? {}));
      normalizeConstraints(candidate, def, changedFields);
      const beforeHook = jsonClone(candidate, 'Update before hooks');
      // T31 (Rule A): staged writes skip hooks (flat, no cascade); every
      // check below plus locks and end-of-batch invariants still runs.
      const hooked =
        stagedBy !== null
          ? candidate
          : await runHooks(def, 'update', candidate, before, id, sink);
      checkKnownFields(hooked, def);
      checkRequired(hooked, def);
      for (const [field, value] of Object.entries(hooked)) {
        if (value === beforeHook[field]) continue;
        // Hook inputs/results are clones: unchanged arrays and objects keep
        // their wire contents, even though their identities differ.
        try {
          if (JSON.stringify(value) !== JSON.stringify(beforeHook[field])) changedFields.add(field);
        } catch {
          changedFields.add(field);
        }
      }
      checkJsonSafe(hooked, def, undefined, changedFields);
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
      drainSink();
      continue;
    }

    if (write.op !== 'remove') {
      throw new Error(`Unknown mutation op: ${JSON.stringify(write.op)}.`);
    }
    if (before === null) {
      throw new StateError('not_found', 'Record not found.');
    }
    // B1: gated callers agree with admission verdict-for-verdict: an
    // archived target reports `Archived records cannot be used here.`
    // (admission's verdict, which the CRUD path inherits) rather than
    // the archive-mode `already archived` verdict below.
    checkGatedArchivedTarget(before, input.gateArchivedTargets === true);
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
    // T31 (Rule A): staged writes skip hooks (flat, no cascade); staged
    // removes are unreachable (stage-time barred) but the guard is total.
    const hooked =
      stagedBy !== null
        ? jsonClone(before.data, 'Remove hook input')
        : await runHooks(
            def,
            'remove',
            jsonClone(before.data, 'Remove hook input'),
            before,
            id,
            sink,
          );
    if (mode === 'archive') {
      checkKnownFields(hooked, def);
      checkRequired(hooked, def);
      // Archiving keeps unchanged legacy data intact. Hook candidates are
      // cloned, so compare their wire contents rather than object identity;
      // newly native or non-JSON values must still pass the changed-field gate.
      const changedFields = new Set(Object.keys(hooked).filter(field => {
        try { return JSON.stringify(hooked[field]) !== JSON.stringify(before.data[field]); }
        catch { return true; }
      }));
      checkJsonSafe(hooked, def, undefined, changedFields, changedFields);
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
      drainSink();
    } else {
      await checkDisposal(write.model, id);
      // B1: net uniques against the batch. The removed row's final keys
      // are nothing, so every claim this batch staged for it is dropped
      // (single-touch removes staged none — this only bites multi-touch
      // batches, where a surviving claim would dangle on a removed row).
      // Releases free the FIRST-touch (committed) keys: a batch-earlier
      // touch may have moved the provisional keys, and freeing those
      // would strand the committed claim. Batch-created rows (first
      // touch null) release nothing — their keys never committed.
      for (let claimIndex = outClaims.length - 1; claimIndex >= 0; claimIndex -= 1) {
        const staged = outClaims[claimIndex];
        if (
          staged !== undefined &&
          (staged.model as string) === (write.model as string) &&
          (staged.recordId as string) === (id as string)
        ) {
          outClaims.splice(claimIndex, 1);
        }
      }
      const committedBefore = firstBefore.get(rowKey) ?? null;
      const releaseSource = committedBefore === null ? null : committedBefore.data;
      if (releaseSource !== null) {
        for (const key of def.uniqueKeys) {
          const canonical = canonicalUnique(releaseSource[key], key, def);
          if (canonical === null) {
            continue;
          }
          outReleases.push({ model: write.model, keyName: key, keyValue: canonical });
        }
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
      drainSink();
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
    schedules: outSchedules,
  };
}

/* -- T34-F5 fanout child writes (ADDITIVE; `runMutationWrites` untouched). -- */

/**
 * T34-F5: one fanout child's domain-write evaluation. Threads the source
 * occurrence's fence point through the pipeline's existing transitive
 * `trigger` seam (hook bodies read it as `transitive.triggerRevision`;
 * the trigger's enrolled dependencies never cross — each child enrolls
 * its own reads under its own checkpoint) and delegates wholesale to
 * `runMutationWrites`. The child's domain writes commit via the caller's
 * atomic child-unit batch (`invokeFanoutChild`), never here.
 */
export interface FanoutChildWritesInput {
  readonly table: ModelTable;
  readonly writes: ReadonlyArray<MutationWrite>;
  readonly context: InvocationContext;
  readonly store: StoragePort;
  /** The source occurrence's fence point (revision + owner only). */
  readonly sourceCheckpoint: { readonly revision: Revision; readonly owner: string };
}

export async function runFanoutChildWrites(
  input: FanoutChildWritesInput,
): Promise<MutationWritesResult> {
  return runMutationWrites({
    table: input.table,
    writes: input.writes,
    context: input.context,
    store: input.store,
    trigger: input.sourceCheckpoint,
  });
}
