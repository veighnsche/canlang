/**
 * Lane 03 S5: INTERIM CRUD operation defs and executor.
 *
 * INTERIM envelope convention (replaced at the L1 codegen join): update and
 * remove take `{ ref }` (a versioned, admission-loaded record ref) plus
 * `patch` (update only, required); create takes `{ id, data, parent? }`.
 * `by` comes from the program (never a default); the candidate precondition
 * `when` lives on the update/remove defs and is threaded into the pipeline.
 */

import { deepFreeze } from '../internal/own-data.js';
import type {
  CanonicalInputDef,
  ModelName,
  OperationName,
  QueryPredicate,
  RecordId,
  StoredRow,
} from '@canlang/contracts';
import type { StoragePort } from '../storage/port.js';
import type { AdmittedCall } from '../invocation/admission.js';
import type { ExecutionEffects, GeneratedCrudReceiptAssociation } from '../invocation/invoke.js';
import type { GeneratedOperationDef, InterimOperationDef } from '../invocation/registry.js';
import { isGeneratedOperationDef } from '../invocation/registry.js';
import { validateByPredicate, type ByPredicate } from '../policy/roles.js';
import { validatePredicateShape } from '../policy/grants.js';
import { StateError } from '../errors.js';
import { beginOwnerMutation, runMutationWrites, type MutationWrite, type MutationWritesInput,
  type OwnerMutationInput, type OwnerMutationSession } from './pipeline.js';
import type { CheckedOwnerModelPolicies } from './model-policies.js';
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
    if (isGeneratedOperationDef(def)) {
      // Wiring bug: generated defs run through generatedCrudExecute, which
      // speaks the flat generated envelopes (this executor speaks interim
      // `{id,data}`/`{ref,patch}` shapes).
      throw new Error('crudExecute handles interim CRUD defs only.');
    }
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
        schedules: effects.schedules,
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
        schedules: effects.schedules,
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
      schedules: effects.schedules,
      uniqueClaims: effects.uniqueClaims,
      uniqueReleases: effects.uniqueReleases,
      resolvedDefaults: effects.resolvedDefaults,
      result: first.kind === 'remove' ? null : first.row,
    };
  };
}

/** `generatedCrudExecute` wiring: model table and target store (multi-model). */
export interface GeneratedCrudExecuteInput {
  readonly table: ModelTable;
  readonly store: StoragePort;
  /** Existing late pipeline conversion for checked field associations. */
  readonly encodeField?: MutationWritesInput['encodeField'];
  /** Checked defining model metadata supplied by trusted host wiring. */
  readonly secretFields?: ReadonlyMap<ModelName, readonly string[]>;
  /** Checked source policy bindings; beginOwnerMutation verifies their private brand. */
  readonly ownerPolicies?: CheckedOwnerModelPolicies;
  /** Required whenever owner execution or a native frame is selected. */
  readonly ownerBounds?: OwnerMutationInput['bounds'];
  /** Install the host's native frame over State's real session; never replace it. */
  readonly createOwnerFrame?: GeneratedCrudOwnerFrameFactory;
}

export interface GeneratedCrudOwnerFrame {
  readonly close: () => void | Promise<void>;
}

/** Source/byte verification and actual Can context/hydration remain the host's job. */
export type GeneratedCrudOwnerFrameFactory = (input: {
  readonly call: AdmittedCall;
  readonly session: OwnerMutationSession;
  readonly context: OwnerMutationSession['views']['context'];
}) => Promise<GeneratedCrudOwnerFrame>;

function generatedCrudAssociation(
  model: ModelName,
  row: StoredRow | null,
  secretFields: GeneratedCrudExecuteInput['secretFields'],
): GeneratedCrudReceiptAssociation {
  const fields = secretFields?.get(model);
  return {
    kind: 'generated-crud/v1',
    model,
    record: row === null ? null : { id: row.id, version: row.version },
    ...(fields === undefined ? {} : { secretFields: [...fields] }),
  };
}

/**
 * Resolve the created model from the `<Model>.create` emission convention.
 * The loader already proved the model sits in the descriptor set; a table
 * miss here means the caller mixed a registry with a foreign table, which
 * is a wiring bug (mirroring the pipeline's unknown-model error).
 */
function generatedCreateModel(def: GeneratedOperationDef, table: ModelTable): ModelName {
  const name = def.descriptor.name as string;
  if (!name.endsWith('.create')) throw new Error('Generated create operation must match its owning model identity.');
  const model = name.slice(0, -'.create'.length) as ModelName;
  if (!table.has(model)) {
    throw new Error(
      `generatedCrudExecute for operation ${JSON.stringify(name)} got a table without model ` +
        `${JSON.stringify(model as string)}.`,
    );
  }
  return model;
}

/**
 * Resolve the synthesized versioned `record` ref of a generated
 * update/delete descriptor. The loader guarantees it; anything else is a
 * wiring bug (a hand-built def that never passed the loader). Ref FIELD
 * inputs beside it are ordinary values, never the target.
 */
function generatedRecordInput(def: GeneratedOperationDef): Extract<
  CanonicalInputDef,
  { kind: 'ref' }
> {
  const record = def.descriptor.inputs.find(
    (input): input is Extract<CanonicalInputDef, { kind: 'ref' }> =>
      input.kind === 'ref' && input.name === 'record',
  );
  if (record === undefined || !record.versioned) {
    throw new Error(
      `generatedCrudExecute for operation ${JSON.stringify(def.descriptor.name as string)} ` +
        'needs a versioned "record" ref.',
    );
  }
  return record;
}

/**
 * T16a generated-CRUD executor: an `ExecuteHandler` serving every generated
 * create/update/delete in one registry through the canonical pipeline.
 *
 * Generated envelope conventions (L1 emission, distinct from the interim
 * `{id,data}`/`{ref,patch}` shapes): creates take flat model fields with NO
 * id input — the record id IS the admitted operation identity
 * (`context.operationId`, frozen across fence retries, so exactly-once per
 * operation: an identical envelope replays instead of duplicating); updates
 * take the versioned record ref beside flat partial changes (omission means
 * unchanged, never default-filled); deletes take the versioned record ref
 * alone. The update/delete target id comes from the admission-loaded ref;
 * the target model comes from the ref input's descriptor model (no name
 * parsing). The def's engine-local `when`, when present, threads into
 * update/delete exactly like interim CRUD (creates never carry one).
 *
 * T18: child-model creates consume the synthesized `parent` ref input
 * (L1 emission, unversioned, caller-required) as record linkage: the
 * admission-loaded parent row becomes the write's parent (existence,
 * unarchived, and fencing all verified at admission; the pipeline
 * re-verifies), and `parent` is deleted from field data — it is
 * linkage, never a field. Parent-defaulted fields then resolve off the
 * loaded parent; parentless creates (root models) keep the pipeline
 * missing-reads-missing rule.
 *
 * Core-scope limits: read/scenario kinds are executor mismatches (reads
 * serve through `invokeRead` plus the query port, scenarios through
 * emitted handlers).
 */
export function generatedCrudExecute(
  input: GeneratedCrudExecuteInput,
): (call: AdmittedCall) => Promise<ExecutionEffects> {
  const { table, store, encodeField, secretFields, ownerPolicies, ownerBounds, createOwnerFrame } = input;
  const ownerExecution = ownerPolicies !== undefined || ownerBounds !== undefined || createOwnerFrame !== undefined;
  if (ownerExecution && ownerBounds === undefined) {
    throw new StateError('validation', 'Generated owner CRUD requires explicit mutation bounds.');
  }
  if (createOwnerFrame !== undefined && typeof createOwnerFrame !== 'function') {
    throw new StateError('validation', 'Generated owner CRUD requires a native frame factory function.');
  }
  const executeWrite = async (call: AdmittedCall, write: MutationWrite): Promise<ExecutionEffects> => {
    const common = { table, context: call.context, store,
      ...(encodeField !== undefined ? { encodeField } : {}) };
    const effects = await (async () => {
      if (!ownerExecution) return runMutationWrites({ ...common, writes: [write] });
      const session = await beginOwnerMutation({ ...common, bounds: ownerBounds!,
        ...(ownerPolicies !== undefined ? { policies: ownerPolicies } : {}) });
      let close: GeneratedCrudOwnerFrame['close'] | undefined;
      try {
        if (createOwnerFrame !== undefined) {
          const frame = await createOwnerFrame(Object.freeze({ call, session, context: session.views.context }));
          const member = typeof frame === 'object' && frame !== null
            ? Object.getOwnPropertyDescriptor(frame, 'close') : undefined;
          if (member !== undefined && 'value' in member && typeof member.value === 'function') {
            close = member.value as GeneratedCrudOwnerFrame['close'];
          }
          if (typeof frame !== 'object' || frame === null ||
              (Object.getPrototypeOf(frame) !== Object.prototype && Object.getPrototypeOf(frame) !== null) ||
              Reflect.ownKeys(frame).length !== 1) {
            throw new StateError('validation', 'Generated CRUD native frame must supply only its cleanup function.');
          }
          if (close === undefined) {
            throw new StateError('validation', 'Generated CRUD native frame needs an own cleanup function.');
          }
        }
        await session.stage(write, { cause: 'crud', input: call.inputs });
        return await session.finalize();
      } finally {
        await close?.();
      }
    })();
    // Owner finalization coalesces hook/secondary writes and reserves one final
    // version per row. The target need not be the first (sorted) net write.
    const target = effects.writes.find(candidate => candidate.model === write.model &&
      (candidate.kind === 'remove' ? candidate.id : candidate.row.id) === write.id);
    if (!ownerExecution && target === undefined) throw new Error(`Mutation pipeline returned no target write for a ${write.op}.`);
    const row = target === undefined || target.kind === 'remove' ? null : target.row;
    return { writes: effects.writes, history: effects.history, outbox: [], schedules: effects.schedules,
      uniqueClaims: effects.uniqueClaims, uniqueReleases: effects.uniqueReleases,
      resolvedDefaults: effects.resolvedDefaults, result: row,
      generatedCrud: generatedCrudAssociation(write.model, row, secretFields) };
  };
  return async (call: AdmittedCall): Promise<ExecutionEffects> => {
    const def = call.def;
    if (!isGeneratedOperationDef(def)) {
      throw new Error('generatedCrudExecute handles generated operation defs only.');
    }
    const kind = def.descriptor.kind;
    if (def.name !== def.descriptor.name || def.kind !== kind || call.context.operation !== def.name) {
      throw new Error('Generated CRUD call and descriptor operation identities disagree.');
    }
    const when = def.when;

    if (kind === 'create') {
      const model = generatedCreateModel(def, table);
      // T18: the synthesized `parent` ref input (child-model creates
      // only) becomes record linkage. The target model comes from the
      // descriptor (no name parsing); the id comes from the
      // admission-loaded ref (admission proved existence, unarchived,
      // and fence enrollment). A declared-but-unloaded parent is a
      // wiring bug (admission loads every declared ref).
      const parentInput = def.descriptor.inputs.find(
        (input): input is Extract<CanonicalInputDef, { kind: 'ref' }> =>
          input.kind === 'ref' && input.name === 'parent',
      );
      let parent: { readonly model: ModelName; readonly id: RecordId } | undefined;
      const data: Record<string, unknown> = { ...call.inputs };
      if (parentInput !== undefined) {
        const parentRef = call.recordRefs.find((entry) => entry.param === parentInput.name);
        if (parentRef === undefined) {
          throw new Error(
            `generatedCrudExecute for operation ${JSON.stringify(def.descriptor.name as string)} ` +
              'got an admitted call with no loaded parent ref.',
          );
        }
        if (parentRef.model !== parentInput.model || parentRef.row.id !== parentRef.id) {
          throw new Error('Generated CRUD parent does not match its admitted binding.');
        }
        parent = { model: parentInput.model, id: parentRef.id };
        delete data[parentInput.name];
      }
      return executeWrite(call, {
        op: 'create',
        model,
        id: call.context.operationId as unknown as RecordId,
        data,
        ...(parent !== undefined ? { parent } : {}),
      });
    }

    if (kind === 'update' || kind === 'delete') {
      const recordInput = generatedRecordInput(def);
      // Admission-loaded refs are looked up by param (a flat ref FIELD
      // input may add further refs after the record one).
      const ref = call.recordRefs.find((entry) => entry.param === recordInput.name);
      if (ref === undefined) {
        throw new Error(
          `generatedCrudExecute ${kind} got an admitted call with no loaded record ref.`,
        );
      }
      if (ref.model !== recordInput.model || ref.row.id !== ref.id ||
          def.name !== `${recordInput.model}.${kind}`) {
        throw new Error('Generated CRUD target and operation do not match their admitted binding.');
      }
      if (!table.has(recordInput.model)) {
        throw new Error(
          `generatedCrudExecute for operation ${JSON.stringify(def.descriptor.name as string)} ` +
            `got a table without model ${JSON.stringify(recordInput.model as string)}.`,
        );
      }
      const patch: Record<string, unknown> = { ...call.inputs };
      delete patch[recordInput.name];
      return executeWrite(call,
        kind === 'update'
          ? { op: 'update', model: recordInput.model, id: ref.id, data: patch,
              ...(when !== undefined ? { when } : {}) }
          : { op: 'remove', model: recordInput.model, id: ref.id,
              ...(when !== undefined ? { when } : {}) },
      );
    }

    throw new Error(
      `generatedCrudExecute handles CRUD defs only, got kind ${JSON.stringify(kind)}.`,
    );
  };
}
