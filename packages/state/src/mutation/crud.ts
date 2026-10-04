/**
 * Lane 03 S5: INTERIM CRUD operation defs and executor.
 *
 * INTERIM envelope convention (replaced at the L1 codegen join): update and
 * remove take `{ ref }` (a versioned, admission-loaded record ref) plus
 * `patch` (update only, required); create takes `{ id, data, parent? }`.
 * `by` comes from the program (never a default); the candidate precondition
 * `when` lives on the update/remove defs and is threaded into the pipeline.
 */

import type {
  ModelName,
  OperationName,
  QueryPredicate,
  RecordId,
} from '../../../contracts/src/state.js';
import type { StoragePort } from '../storage/port.js';
import type { AdmittedCall } from '../invocation/admission.js';
import type { ExecutionEffects } from '../invocation/invoke.js';
import type { InterimOperationDef } from '../invocation/registry.js';
import { validateByPredicate, type ByPredicate } from '../policy/roles.js';
import { validatePredicateShape } from '../policy/grants.js';
import { StateError } from '../errors.js';
import { runMutationWrites } from './pipeline.js';
import type { ModelTable } from './models.js';

/** INTERIM CRUD def: an operation def with an optional candidate `when`. */
export interface CrudOperationDef extends InterimOperationDef {
  readonly when?: QueryPredicate;
}

/** INTERIM CRUD def options: program authorization plus precondition. */
export interface CrudDefsOptions {
  readonly by: ByPredicate;
  readonly when?: QueryPredicate;
}

/** INTERIM CRUD def triple for one model. */
export interface CrudDefs {
  readonly create: CrudOperationDef;
  readonly update: CrudOperationDef;
  readonly remove: CrudOperationDef;
}

/** Fail-closed interim bound on caller-supplied record ids. */
export const CRUD_MAX_ID_LENGTH = 128;

/** Deep-freeze def ASTs so post-build mutation cannot alter enforcement. */
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
 * Build the INTERIM CRUD def triple for one model: `${model}.create`,
 * `${model}.update`, `${model}.delete` (registry kind `crud.delete`; the
 * triple key stays `remove`). `when`, when given, attaches to update/remove
 * only — creates never carry a candidate precondition. Throws plain `Error`
 * on malformed `by`/`when` (programmer bugs, fail fast).
 */
export function crudDefs(model: ModelName, opts: CrudDefsOptions): CrudDefs {
  const tag = JSON.stringify(model as string);
  validateByPredicate(opts.by, `crud by for model ${tag}`);
  if (opts.when !== undefined) {
    try {
      validatePredicateShape(opts.when);
    } catch (error) {
      throw new Error(
        `Invalid crud when for model ${tag}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let by: ByPredicate;
  let when: QueryPredicate | undefined;
  try {
    by = structuredClone(opts.by);
    when = opts.when === undefined ? undefined : structuredClone(opts.when);
  } catch {
    throw new Error(`Invalid crud defs for model ${tag}: defs must be serializable data.`);
  }
  const frozenWhen = when === undefined ? undefined : deepFreeze(when);
  // Defs are frozen (by shared by reference across the triple): post-build
  // mutation of the returned defs cannot alter enforcement.
  const frozenBy = deepFreeze(by);
  const freezeDef = <T extends InterimOperationDef>(def: T): T =>
    Object.freeze({
      ...def,
      by: frozenBy,
      inputs: deepFreeze({ ...def.inputs }),
    }) as T;
  return {
    create: freezeDef({
      name: `${model as string}.create` as OperationName,
      kind: 'crud.create',
      by: frozenBy,
      inputs: {
        id: { type: 'scalar', required: true },
        data: { type: 'scalar', required: true },
        // INTERIM scalar: the child def declares no parent model, so the
        // parent input is self-describing `{ model, id }` (validated in
        // crudExecute); L1 will type parent refs properly.
        parent: { type: 'scalar', required: false },
      },
    }),
    update: freezeDef({
      name: `${model as string}.update` as OperationName,
      kind: 'crud.update',
      by: frozenBy,
      inputs: {
        ref: { type: 'record', model, versioned: true, required: true },
        patch: { type: 'scalar', required: true },
      },
      ...(frozenWhen !== undefined ? { when: frozenWhen } : {}),
    }),
    remove: freezeDef({
      name: `${model as string}.delete` as OperationName,
      kind: 'crud.delete',
      by: frozenBy,
      inputs: {
        ref: { type: 'record', model, versioned: true, required: true },
      },
      ...(frozenWhen !== undefined ? { when: frozenWhen } : {}),
    }),
  };
}

/** `crudExecute` wiring: model table, owning model, and target store. */
export interface CrudExecuteInput {
  readonly table: ModelTable;
  readonly model: ModelName;
  readonly store: StoragePort;
}

/** Plain-object check (arrays and nulls are never domain objects). */
function isDataObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build the INTERIM CRUD executor for one model: an `ExecuteHandler` that
 * maps the admitted call onto a single pipeline write. Update/remove read
 * the target id from `call.recordRefs[0]` (admission-loaded) and let the
 * pipeline re-load via the provisional map — one slight double-read for
 * uniform code. `result` is the post-write row, or null for hard removes
 * (full row incl. server-only fields interim; result projection through the
 * read port is future work).
 */
export function crudExecute(
  input: CrudExecuteInput,
): (call: AdmittedCall) => Promise<ExecutionEffects> {
  const { table, model, store } = input;
  return async (call: AdmittedCall): Promise<ExecutionEffects> => {
    const def = call.def;
    if (!(def.name as string).startsWith(`${model as string}.`)) {
      // Wiring bug: this executor only serves its own model's CRUD defs.
      throw new Error(
        `crudExecute for model ${JSON.stringify(model as string)} got operation ` +
          `${JSON.stringify(def.name as string)}.`,
      );
    }
    const when = (def as CrudOperationDef).when;

    if (def.kind === 'crud.create') {
      const id = call.inputs['id'];
      if (typeof id !== 'string' || id === '') {
        throw new StateError('validation', 'Record id must be a non-empty string.');
      }
      if (id.length > CRUD_MAX_ID_LENGTH) {
        throw new StateError(
          'validation',
          `Record id exceeds ${CRUD_MAX_ID_LENGTH} characters.`,
        );
      }
      const data = call.inputs['data'];
      if (!isDataObject(data)) {
        throw new StateError('validation', 'Create data must be an object.');
      }
      const parentInput = call.inputs['parent'];
      let parent: { readonly model: ModelName; readonly id: RecordId } | undefined;
      if (parentInput !== undefined) {
        if (!isDataObject(parentInput)) {
          throw new StateError('validation', 'Invalid parent reference.');
        }
        const parentModel = parentInput['model'];
        const parentId = parentInput['id'];
        if (
          typeof parentModel !== 'string' ||
          parentModel === '' ||
          typeof parentId !== 'string' ||
          parentId === ''
        ) {
          throw new StateError('validation', 'Invalid parent reference.');
        }
        if (Object.hasOwn(parentInput, 'version')) {
          throw new StateError('validation', 'Parent references are unversioned.');
        }
        parent = { model: parentModel as ModelName, id: parentId as RecordId };
      }
      const effects = await runMutationWrites({
        table,
        // Creates never carry `when` (update/remove only), even if a
        // hand-built def attached one.
        writes: [
          {
            op: 'create',
            model,
            id: id as RecordId,
            data,
            ...(parent !== undefined ? { parent } : {}),
          },
        ],
        context: call.context,
        store,
      });
      const first = effects.writes[0];
      if (first === undefined) {
        throw new Error('Mutation pipeline returned no write for a create.');
      }
      return {
        writes: effects.writes,
        history: effects.history,
        outbox: [],
        schedules: [],
        uniqueClaims: effects.uniqueClaims,
        uniqueReleases: effects.uniqueReleases,
        resolvedDefaults: effects.resolvedDefaults,
        result: first.kind === 'remove' ? null : first.row,
      };
    }

    if (def.kind === 'crud.update') {
      const ref = call.recordRefs[0];
      if (ref === undefined) {
        // Def/call mismatch: the update def requires a record ref, so
        // admission always loads one; its absence is a wiring bug.
        throw new Error('crudExecute update got an admitted call with no record ref.');
      }
      const patch = call.inputs['patch'];
      if (!isDataObject(patch)) {
        throw new StateError('validation', 'Update patch must be an object.');
      }
      const effects = await runMutationWrites({
        table,
        writes: [
          {
            op: 'update',
            model,
            id: ref.id,
            data: patch,
            ...(when !== undefined ? { when } : {}),
          },
        ],
        context: call.context,
        store,
      });
      const first = effects.writes[0];
      if (first === undefined) {
        throw new Error('Mutation pipeline returned no write for an update.');
      }
      return {
        writes: effects.writes,
        history: effects.history,
        outbox: [],
        schedules: [],
        uniqueClaims: effects.uniqueClaims,
        uniqueReleases: effects.uniqueReleases,
        resolvedDefaults: effects.resolvedDefaults,
        result: first.kind === 'remove' ? null : first.row,
      };
    }

    if (def.kind !== 'crud.delete') {
      throw new Error(
        `crudExecute handles CRUD defs only, got kind ${JSON.stringify(def.kind)}.`,
      );
    }
    const ref = call.recordRefs[0];
    if (ref === undefined) {
      throw new Error('crudExecute remove got an admitted call with no record ref.');
    }
    const effects = await runMutationWrites({
      table,
      writes: [
        {
          op: 'remove',
          model,
          id: ref.id,
          ...(when !== undefined ? { when } : {}),
        },
      ],
      context: call.context,
      store,
    });
    const first = effects.writes[0];
    if (first === undefined) {
      throw new Error('Mutation pipeline returned no write for a remove.');
    }
    return {
      writes: effects.writes,
      history: effects.history,
      outbox: [],
      schedules: [],
      uniqueClaims: effects.uniqueClaims,
      uniqueReleases: effects.uniqueReleases,
      resolvedDefaults: effects.resolvedDefaults,
      result: first.kind === 'remove' ? null : first.row,
    };
  };
}
