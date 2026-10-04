/**
 * Lane 03 S7: migration transition validation (pure, no I/O).
 *
 * Validates one compiled per-owner `MigrationTransition` against the
 * installed predecessor snapshot plus the old/desired interim model tables,
 * producing a frozen `ValidatedMigrationPlan` the staging/validate/activate
 * stages execute. Every inconsistency is a `StateError` validation — never a
 * crash, never a silent coercion.
 *
 * INTERIM intake: L1 owns the canonical snapshot/plan format when it lands;
 * until then this module interprets the execution-side intake shapes from
 * `packages/contracts/src/state.ts`:
 * - `renameField`/`dropField` name their model in the OLD (source)
 *   namespace; `backfill` names its model in the DESIRED (target) namespace.
 * - An owner rename carries no implicit model remapping: model identity
 *   moves only through explicit `renameModel` directives. The owner action
 *   affects the snapshot pointer (plus `renameFromOwner` at flip) only.
 * - Owner membership of a model name uses the `Owner.Model` prefix
 *   convention (segment before the first `.`); unprefixed names never match
 *   a non-empty owner, so the drop-owner check is lenient for them.
 * - Desired-field coverage without backfill is rejected here (fail early):
 *   every desired stored field needs a structural source or a backfill
 *   model, because mappers must initialize every stored field.
 */

import type {
  InstalledSnapshot,
  MigrationDirective,
  MigrationTransition,
  ModelName,
} from '../../../contracts/src/state.js';
import {
  buildModelTable,
  type InterimModelDef,
  type ModelTable,
} from '../mutation/models.js';
import { StateError } from '../errors.js';

/** Per-old-model disposition in a validated plan. */
export type ValidatedModelKind = 'retain' | 'rename' | 'drop';

/** Per-old-field disposition in a validated plan. */
export type ValidatedFieldMapping =
  | { readonly kind: 'retain' }
  | { readonly kind: 'rename'; readonly to: string }
  | { readonly kind: 'drop' };

/**
 * Validated per-old-model mapping. `fields` covers EVERY old field exactly
 * once. `needsStaging` is false only for pure retains (no rename, no
 * backfill, no field changes): their live rows persist untouched, so
 * staging skips them, publish leaves them, and validation reads them live.
 */
export interface ValidatedModelMapping {
  readonly kind: ValidatedModelKind;
  /** Desired-model target for retain/rename; null for drops. */
  readonly target: ModelName | null;
  readonly fields: ReadonlyMap<string, ValidatedFieldMapping>;
  readonly needsBackfill: boolean;
  readonly needsStaging: boolean;
  /** True when any old field drops (a conversion even without backfill). */
  readonly hasFieldDrops: boolean;
}

/** Validated owner-level action: retained, renamed once, or dropped. */
export type ValidatedOwnerAction =
  | { readonly kind: 'retain' }
  | { readonly kind: 'rename'; readonly from: string }
  | { readonly kind: 'drop' };

/**
 * Frozen validated plan view: per-model mappings plus the owner action and
 * invalidate contracts. `models` is keyed by OLD model name (implicit
 * retains included); `targets` maps each staged TARGET model to its single
 * old source; `newModels` are desired models with no old source (start
 * empty — backfill on them is rejected).
 */
export interface ValidatedMigrationPlan {
  readonly migrationId: string;
  readonly owner: string;
  readonly fromSnapshotId: string;
  readonly fromDigest: string;
  readonly toSnapshotId: string;
  readonly toDigest: string;
  readonly bodyDigest: string;
  readonly ownerAction: ValidatedOwnerAction;
  readonly models: ReadonlyMap<ModelName, ValidatedModelMapping>;
  readonly targets: ReadonlyMap<ModelName, ModelName>;
  readonly newModels: ReadonlyArray<ModelName>;
  readonly backfills: ReadonlySet<ModelName>;
  readonly invalidates: ReadonlyArray<string>;
}

/** Non-empty string check for compiler-supplied plan identity fields. */
function checkPlanString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new StateError('validation', `Migration plan ${what} must be a non-empty string.`);
  }
  return value;
}

/**
 * Owner segment of a model name (`Owner.Model` convention). Unprefixed
 * names yield `''`, which never equals a non-empty owner.
 */
function ownerPrefixOf(model: string): string {
  const dot = model.indexOf('.');
  return dot === -1 ? '' : model.slice(0, dot);
}

/** Sorted model names for deterministic sweep/error precedence. */
function sortedNames(table: ModelTable): string[] {
  return [...table.keys()].map((name) => name as string).sort();
}

type SourceConsumption = 'renameModel' | 'dropModel';
type FieldConsumption = 'renameField' | 'dropField';

interface CollectedDirectives {
  readonly renameModels: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly dropModels: ReadonlyArray<string>;
  readonly renameFields: ReadonlyArray<{ readonly model: string; readonly from: string; readonly to: string }>;
  readonly dropFields: ReadonlyArray<{ readonly model: string; readonly field: string }>;
  readonly backfills: ReadonlyArray<string>;
  readonly invalidates: ReadonlyArray<string>;
}

/** Shape-check directives and bucket them by kind (unknown kinds block). */
function collectDirectives(directives: ReadonlyArray<MigrationDirective>): CollectedDirectives {
  const renameModels: Array<{ from: string; to: string }> = [];
  const dropModels: string[] = [];
  const renameFields: Array<{ model: string; from: string; to: string }> = [];
  const dropFields: Array<{ model: string; field: string }> = [];
  const backfills: string[] = [];
  const invalidates: string[] = [];
  for (const directive of directives) {
    if (typeof directive !== 'object' || directive === null || Array.isArray(directive)) {
      throw new StateError('validation', 'Migration directives must be objects.');
    }
    switch ((directive as MigrationDirective).kind) {
      case 'renameOwner':
      case 'dropOwner':
        break;
      case 'renameModel': {
        const from = checkPlanString(
          (directive as { from?: unknown }).from,
          'renameModel.from',
        );
        const to = checkPlanString((directive as { to?: unknown }).to, 'renameModel.to');
        renameModels.push({ from, to });
        break;
      }
      case 'renameField': {
        const model = checkPlanString(
          (directive as { model?: unknown }).model,
          'renameField.model',
        );
        const from = checkPlanString(
          (directive as { from?: unknown }).from,
          'renameField.from',
        );
        const to = checkPlanString((directive as { to?: unknown }).to, 'renameField.to');
        renameFields.push({ model, from, to });
        break;
      }
      case 'dropModel':
        dropModels.push(
          checkPlanString((directive as { model?: unknown }).model, 'dropModel.model'),
        );
        break;
      case 'dropField': {
        const model = checkPlanString(
          (directive as { model?: unknown }).model,
          'dropField.model',
        );
        const field = checkPlanString(
          (directive as { field?: unknown }).field,
          'dropField.field',
        );
        dropFields.push({ model, field });
        break;
      }
      case 'backfill':
        backfills.push(
          checkPlanString((directive as { model?: unknown }).model, 'backfill.model'),
        );
        break;
      case 'invalidate': {
        const contract = (directive as { handlerContract?: unknown }).handlerContract;
        if (typeof contract !== 'string' || contract === '') {
          throw new StateError(
            'validation',
            'Migration invalidate needs a non-empty handlerContract.',
          );
        }
        invalidates.push(contract);
        break;
      }
      default:
        throw new StateError(
          'validation',
          `Unknown migration directive: ${JSON.stringify((directive as { kind?: unknown }).kind)}.`,
        );
    }
  }
  return { renameModels, dropModels, renameFields, dropFields, backfills, invalidates };
}

/**
 * Validate one per-owner transition against its installed predecessor.
 * Fresh installs (installed null) never apply transitions — they take the
 * separate `freshInstallSnapshot` path.
 */
export function validateTransition(
  installed: InstalledSnapshot | null,
  plan: MigrationTransition,
  oldModels: ModelTable,
  desiredModels: ModelTable,
): ValidatedMigrationPlan {
  if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) {
    throw new StateError('validation', 'Migration plan must be an object.');
  }
  const migrationId = checkPlanString(plan.migrationId, 'migrationId');
  const owner = checkPlanString(plan.owner, 'owner');
  const fromSnapshotId = checkPlanString(plan.fromSnapshotId, 'fromSnapshotId');
  const fromDigest = checkPlanString(plan.fromDigest, 'fromDigest');
  const toSnapshotId = checkPlanString(plan.toSnapshotId, 'toSnapshotId');
  const toDigest = checkPlanString(plan.toDigest, 'toDigest');
  const bodyDigest = checkPlanString(plan.bodyDigest, 'bodyDigest');
  if (!Array.isArray(plan.directives)) {
    throw new StateError('validation', 'Migration plan directives must be an array.');
  }
  if (installed === null) {
    throw new StateError(
      'validation',
      'Fresh installs never apply transitions; initialize the current schema directly.',
    );
  }
  if (fromSnapshotId !== installed.snapshotId) {
    throw new StateError(
      'validation',
      `Migration predecessor mismatch: transition is from snapshot ` +
        `${JSON.stringify(fromSnapshotId)} but installed is ` +
        `${JSON.stringify(installed.snapshotId)}.`,
    );
  }
  if (fromDigest !== installed.digest) {
    throw new StateError('validation', 'Migration predecessor mismatch: fromDigest differs.');
  }

  const renameOwners = plan.directives.filter(
    (directive) => (directive as MigrationDirective).kind === 'renameOwner',
  );
  const dropOwners = plan.directives.filter(
    (directive) => (directive as MigrationDirective).kind === 'dropOwner',
  );
  if (renameOwners.length > 0 && dropOwners.length > 0) {
    throw new StateError('validation', 'Migration cannot both rename and drop its owner.');
  }
  if (renameOwners.length > 1) {
    throw new StateError('validation', 'Migration renames its owner more than once.');
  }
  if (dropOwners.length > 1) {
    throw new StateError('validation', 'Migration drops its owner more than once.');
  }
  const collected = collectDirectives(plan.directives);

  let ownerAction: ValidatedOwnerAction;
  const renameOwner = renameOwners[0] as { from?: unknown } | undefined;
  if (renameOwner !== undefined) {
    const from = checkPlanString(renameOwner.from, 'renameOwner.from');
    if (from !== installed.owner) {
      throw new StateError(
        'validation',
        `Migration renameOwner is from ${JSON.stringify(from)} but installed owner is ` +
          `${JSON.stringify(installed.owner)}.`,
      );
    }
    ownerAction = Object.freeze({ kind: 'rename', from });
  } else if (dropOwners.length > 0) {
    if (owner !== installed.owner) {
      throw new StateError(
        'validation',
        'Migration dropOwner headers must name the removed installed owner.',
      );
    }
    for (const desired of desiredModels.keys()) {
      if (ownerPrefixOf(desired as string) === owner) {
        throw new StateError(
          'validation',
          `Migration drops owner ${JSON.stringify(owner)} but desired models still carry it.`,
        );
      }
    }
    if (
      collected.renameModels.length > 0 ||
      collected.dropModels.length > 0 ||
      collected.renameFields.length > 0 ||
      collected.dropFields.length > 0 ||
      collected.backfills.length > 0
    ) {
      throw new StateError(
        'validation',
        'Migration dropOwner takes no model, field, or backfill directives.',
      );
    }
    ownerAction = Object.freeze({ kind: 'drop' });
    const models = new Map<ModelName, ValidatedModelMapping>();
    for (const name of sortedNames(oldModels)) {
      const def = oldModels.get(name as ModelName);
      if (def === undefined) {
        continue;
      }
      const fields = new Map<string, ValidatedFieldMapping>();
      for (const field of Object.keys(def.fields)) {
        fields.set(field, Object.freeze({ kind: 'drop' }));
      }
      models.set(
        name as ModelName,
        Object.freeze({
          kind: 'drop',
          target: null,
          fields,
          needsBackfill: false,
          needsStaging: false,
          hasFieldDrops: false,
        }),
      );
    }
    return freezePlan({
      migrationId,
      owner,
      fromSnapshotId,
      fromDigest,
      toSnapshotId,
      toDigest,
      bodyDigest,
      ownerAction,
      models,
      targets: new Map(),
      newModels: sortedNames(desiredModels).map((name) => name as ModelName),
      backfills: new Set(),
      invalidates: [...new Set(collected.invalidates)].sort(),
    });
  } else {
    if (owner !== installed.owner) {
      throw new StateError(
        'validation',
        `Migration owner ${JSON.stringify(owner)} differs from installed owner ` +
          `${JSON.stringify(installed.owner)} without a renameOwner directive.`,
      );
    }
    ownerAction = Object.freeze({ kind: 'retain' });
  }

  // Pass 1: source consumption (each old model retained, renamed, or
  // dropped exactly once; a drop cannot also map the same source).
  const consumedSources = new Map<string, SourceConsumption>();
  const consumeSource = (name: string, kind: SourceConsumption): void => {
    if (!oldModels.has(name as ModelName)) {
      throw new StateError(
        'validation',
        `Migration ${kind} names unknown old model ${JSON.stringify(name)}.`,
      );
    }
    const prior = consumedSources.get(name);
    if (prior !== undefined) {
      throw new StateError(
        'validation',
        `Migration handles old model ${JSON.stringify(name)} twice (${prior}, ${kind}).`,
      );
    }
    consumedSources.set(name, kind);
  };
  for (const rename of collected.renameModels) {
    consumeSource(rename.from, 'renameModel');
  }
  for (const name of collected.dropModels) {
    consumeSource(name, 'dropModel');
    if (desiredModels.has(name as ModelName)) {
      throw new StateError(
        'validation',
        `Migration drops model ${JSON.stringify(name)} but desired models still declare it.`,
      );
    }
  }

  // Pass 2: rename targets (each target at most one source; renaming onto
  // a retained model is a collision).
  const renameTargets = new Map<string, string>();
  const renameSources = new Map<string, string>();
  for (const rename of collected.renameModels) {
    if (!desiredModels.has(rename.to as ModelName)) {
      throw new StateError(
        'validation',
        `Migration renameModel targets unknown desired model ${JSON.stringify(rename.to)}.`,
      );
    }
    const prior = renameTargets.get(rename.to);
    if (prior !== undefined) {
      throw new StateError(
        'validation',
        `Migration target ${JSON.stringify(rename.to)} has two sources ` +
          `(${JSON.stringify(prior)}, ${JSON.stringify(rename.from)}).`,
      );
    }
    if (oldModels.has(rename.to as ModelName) && !consumedSources.has(rename.to)) {
      throw new StateError(
        'validation',
        `Migration renameModel to ${JSON.stringify(rename.to)} collides with the retained model.`,
      );
    }
    renameTargets.set(rename.to, rename.from);
    renameSources.set(rename.from, rename.to);
  }

  // Pass 3: field directives (old-namespace models; each old field
  // retained, renamed, or dropped exactly once).
  const fieldConsumption = new Map<string, Map<string, FieldConsumption>>();
  const fieldTargets = new Map<string, Map<string, string>>();
  const consumedFieldsFor = (model: string): Map<string, FieldConsumption> => {
    let fields = fieldConsumption.get(model);
    if (fields === undefined) {
      fields = new Map();
      fieldConsumption.set(model, fields);
    }
    return fields;
  };
  const fieldTargetModel = (model: string): string => {
    if (!oldModels.has(model as ModelName)) {
      throw new StateError(
        'validation',
        `Migration field directive names unknown old model ${JSON.stringify(model)}.`,
      );
    }
    if (consumedSources.get(model) === 'dropModel') {
      throw new StateError(
        'validation',
        `Migration field directive targets dropped model ${JSON.stringify(model)}.`,
      );
    }
    const resolved = renameSources.get(model) ?? model;
    if (!desiredModels.has(resolved as ModelName)) {
      throw new StateError(
        'validation',
        `Migration removes model ${JSON.stringify(model)} without a drop or rename.`,
      );
    }
    return resolved;
  };
  const consumeField = (model: string, field: string, kind: FieldConsumption): void => {
    const def = oldModels.get(model as ModelName);
    if (def === undefined || !Object.hasOwn(def.fields, field)) {
      throw new StateError(
        'validation',
        `Migration ${kind} names unknown old field ${JSON.stringify(field)} on model ` +
          `${JSON.stringify(model)}.`,
      );
    }
    const consumed = consumedFieldsFor(model);
    const prior = consumed.get(field);
    if (prior !== undefined) {
      throw new StateError(
        'validation',
        `Migration handles old field ${JSON.stringify(model)}.${JSON.stringify(field)} twice ` +
          `(${prior}, ${kind}).`,
      );
    }
    consumed.set(field, kind);
  };
  for (const rename of collected.renameFields) {
    const target = fieldTargetModel(rename.model);
    consumeField(rename.model, rename.from, 'renameField');
    const desired = desiredModels.get(target as ModelName);
    if (desired === undefined || !Object.hasOwn(desired.fields, rename.to)) {
      throw new StateError(
        'validation',
        `Migration renameField maps to undeclared desired field ${JSON.stringify(rename.to)} ` +
          `on model ${JSON.stringify(target)}.`,
      );
    }
    let targets = fieldTargets.get(target);
    if (targets === undefined) {
      targets = new Map();
      fieldTargets.set(target, targets);
    }
    const prior = targets.get(rename.to);
    if (prior !== undefined) {
      throw new StateError(
        'validation',
        `Migration target field ${JSON.stringify(target)}.${JSON.stringify(rename.to)} has two ` +
          `sources (${JSON.stringify(prior)}, ${JSON.stringify(rename.from)}).`,
      );
    }
    targets.set(rename.to, `${rename.model}.${rename.from}`);
  }
  for (const drop of collected.dropFields) {
    const target = fieldTargetModel(drop.model);
    consumeField(drop.model, drop.field, 'dropField');
    const desired = desiredModels.get(target as ModelName);
    if (desired !== undefined && Object.hasOwn(desired.fields, drop.field)) {
      throw new StateError(
        'validation',
        `Migration drops field ${JSON.stringify(drop.model)}.${JSON.stringify(drop.field)} but ` +
          `desired models still declare it.`,
      );
    }
  }

  // Pass 4: backfills (one per target model; the target needs a live source).
  const backfills = new Set<string>();
  for (const name of collected.backfills) {
    if (!desiredModels.has(name as ModelName)) {
      throw new StateError(
        'validation',
        `Migration backfill names unknown desired model ${JSON.stringify(name)}.`,
      );
    }
    if (backfills.has(name)) {
      throw new StateError(
        'validation',
        `Migration backfills model ${JSON.stringify(name)} twice.`,
      );
    }
    const retained = oldModels.has(name as ModelName) && !consumedSources.has(name);
    if (!retained && !renameTargets.has(name)) {
      throw new StateError(
        'validation',
        `Migration backfill for dropped or unmapped model ${JSON.stringify(name)}.`,
      );
    }
    backfills.add(name);
  }

  // Final sweep: build per-model mappings over every old model.
  const models = new Map<ModelName, ValidatedModelMapping>();
  const targets = new Map<ModelName, ModelName>();
  for (const name of sortedNames(oldModels)) {
    const def = oldModels.get(name as ModelName);
    if (def === undefined) {
      continue;
    }
    const consumed = consumedSources.get(name);
    if (consumed === 'dropModel') {
      const fields = new Map<string, ValidatedFieldMapping>();
      for (const field of Object.keys(def.fields)) {
        fields.set(field, Object.freeze({ kind: 'drop' }));
      }
      models.set(
        name as ModelName,
        Object.freeze({
          kind: 'drop',
          target: null,
          fields,
          needsBackfill: false,
          needsStaging: false,
          hasFieldDrops: false,
        }),
      );
      continue;
    }
    const target = renameSources.get(name) ?? name;
    if (!desiredModels.has(target as ModelName)) {
      throw new StateError(
        'validation',
        `Migration removes model ${JSON.stringify(name)} without a drop or rename.`,
      );
    }
    const desired = desiredModels.get(target as ModelName);
    if (desired === undefined) {
      throw new StateError(
        'validation',
        `Migration target ${JSON.stringify(target)} has no desired def.`,
      );
    }
    const consumedFields = fieldConsumption.get(name) ?? new Map<string, FieldConsumption>();
    const fields = new Map<string, ValidatedFieldMapping>();
    let hasFieldDrops = false;
    let hasFieldRenames = false;
    for (const field of Object.keys(def.fields)) {
      const handling = consumedFields.get(field);
      if (handling === 'dropField') {
        fields.set(field, Object.freeze({ kind: 'drop' }));
        hasFieldDrops = true;
        continue;
      }
      if (handling === 'renameField') {
        const rename = collected.renameFields.find(
          (entry) => entry.model === name && entry.from === field,
        );
        if (rename === undefined) {
          throw new StateError(
            'validation',
            `Migration lost the rename target for ${JSON.stringify(name)}.${JSON.stringify(field)}.`,
          );
        }
        if (
          rename.to !== field &&
          Object.hasOwn(def.fields, rename.to) &&
          !consumedFields.has(rename.to) &&
          Object.hasOwn(desired.fields, rename.to)
        ) {
          throw new StateError(
            'validation',
            `Migration target field ${JSON.stringify(target)}.${JSON.stringify(rename.to)} ` +
              `collides with the retained field.`,
          );
        }
        fields.set(field, Object.freeze({ kind: 'rename', to: rename.to }));
        hasFieldRenames = true;
        continue;
      }
      if (!Object.hasOwn(desired.fields, field)) {
        throw new StateError(
          'validation',
          `Migration removes field ${JSON.stringify(name)}.${JSON.stringify(field)} without ` +
            `a drop or rename.`,
        );
      }
      fields.set(field, Object.freeze({ kind: 'retain' }));
    }
    const needsBackfill = backfills.has(target);
    if (!needsBackfill) {
      for (const desiredField of Object.keys(desired.fields)) {
        const retainedSource =
          Object.hasOwn(def.fields, desiredField) && !consumedFields.has(desiredField);
        const renamedSource = fieldTargets.get(target)?.has(desiredField) === true;
        if (!retainedSource && !renamedSource) {
          throw new StateError(
            'validation',
            `Migration leaves desired field ${JSON.stringify(target)}.${JSON.stringify(desiredField)} ` +
              `without a source or backfill.`,
          );
        }
      }
    }
    if (targets.has(target as ModelName)) {
      throw new StateError(
        'validation',
        `Migration target ${JSON.stringify(target)} has two sources.`,
      );
    }
    targets.set(target as ModelName, name as ModelName);
    const kind: ValidatedModelKind = consumed === 'renameModel' ? 'rename' : 'retain';
    models.set(
      name as ModelName,
      Object.freeze({
        kind,
        target: target as ModelName,
        fields,
        needsBackfill,
        needsStaging: kind === 'rename' || needsBackfill || hasFieldDrops || hasFieldRenames,
        hasFieldDrops,
      }),
    );
  }

  const newModels: ModelName[] = [];
  for (const name of sortedNames(desiredModels)) {
    if (!targets.has(name as ModelName)) {
      newModels.push(name as ModelName);
    }
  }

  return freezePlan({
    migrationId,
    owner,
    fromSnapshotId,
    fromDigest,
    toSnapshotId,
    toDigest,
    bodyDigest,
    ownerAction,
    models,
    targets,
    newModels,
    backfills: new Set([...backfills].sort().map((name) => name as ModelName)),
    invalidates: [...new Set(collected.invalidates)].sort(),
  });
}

/** Freeze the plan view (maps frozen by convention, as in buildModelTable). */
function freezePlan(plan: {
  readonly migrationId: string;
  readonly owner: string;
  readonly fromSnapshotId: string;
  readonly fromDigest: string;
  readonly toSnapshotId: string;
  readonly toDigest: string;
  readonly bodyDigest: string;
  readonly ownerAction: ValidatedOwnerAction;
  readonly models: ReadonlyMap<ModelName, ValidatedModelMapping>;
  readonly targets: ReadonlyMap<ModelName, ModelName>;
  readonly newModels: ReadonlyArray<ModelName>;
  readonly backfills: ReadonlySet<ModelName>;
  readonly invalidates: ReadonlyArray<string>;
}): ValidatedMigrationPlan {
  return Object.freeze({
    migrationId: plan.migrationId,
    owner: plan.owner,
    fromSnapshotId: plan.fromSnapshotId,
    fromDigest: plan.fromDigest,
    toSnapshotId: plan.toSnapshotId,
    toDigest: plan.toDigest,
    bodyDigest: plan.bodyDigest,
    ownerAction: plan.ownerAction,
    models: Object.freeze(plan.models),
    targets: Object.freeze(plan.targets),
    newModels: Object.freeze([...plan.newModels]),
    backfills: Object.freeze(plan.backfills),
    invalidates: Object.freeze([...plan.invalidates]),
  });
}

/** Fresh-install validation input: snapshot shape plus desired defs. */
export interface FreshInstallInput {
  readonly snapshot: InstalledSnapshot;
  readonly desired: ReadonlyArray<InterimModelDef>;
}

/**
 * Validate a fresh install (VALIDATION ONLY — pure, no I/O). Fresh installs
 * never apply transitions; they check the install snapshot shape and prove
 * the desired defs compile.
 *
 * CONTRACT GAP (loud): there is no storage call recording the installed
 * pointer for a fresh install, so this function records nothing. Pointer
 * recording rides the deployment's own fenced write (L7 owns that write
 * until a `recordInstalledSnapshot` intake lands). The coordinator must
 * close this gap before fresh-install upgrades ship.
 */
export function freshInstallSnapshot(input: FreshInstallInput): {
  readonly owner: string;
  readonly snapshotId: string;
  readonly digest: string;
  readonly models: ModelTable;
} {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new StateError('validation', 'Fresh install input must be an object.');
  }
  const snapshot = input.snapshot;
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new StateError('validation', 'Fresh install snapshot must be an object.');
  }
  const owner = checkPlanString(snapshot.owner, 'snapshot.owner');
  const snapshotId = checkPlanString(snapshot.snapshotId, 'snapshot.snapshotId');
  const digest = checkPlanString(snapshot.digest, 'snapshot.digest');
  if (
    typeof snapshot.installedRevision !== 'number' ||
    !Number.isInteger(snapshot.installedRevision) ||
    snapshot.installedRevision < 0
  ) {
    throw new StateError(
      'validation',
      'Fresh install snapshot.installedRevision must be an integer >= 0.',
    );
  }
  if (
    typeof snapshot.installedAt !== 'number' ||
    !Number.isFinite(snapshot.installedAt) ||
    snapshot.installedAt < 0
  ) {
    throw new StateError(
      'validation',
      'Fresh install snapshot.installedAt must be a finite number >= 0.',
    );
  }
  if (!Array.isArray(input.desired)) {
    throw new StateError('validation', 'Fresh install desired defs must be an array.');
  }
  let models: ModelTable;
  try {
    models = buildModelTable(input.desired);
  } catch (error) {
    // Deployment descriptors are caller input at this boundary, so
    // build-time programmer errors surface as validation, fail closed.
    throw new StateError(
      'validation',
      `Fresh install desired defs do not compile: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { owner, snapshotId, digest, models };
}
