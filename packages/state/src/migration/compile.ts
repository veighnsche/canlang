/**
 * Lane 03 S7: migration plan compilation (INTERIM intake until L1 lands).
 *
 * Compiles one owner's `MigrationTransition` from an old and a desired
 * release (model tables plus artifact digests): schema-diff to structural
 * directives plus deterministic snapshot-id minting. The engine keeps
 * treating ids and digests as opaque strings; this module defines their
 * interim meaning as a split binding (JEV 3/3; see DECISIONS.md):
 *
 * - snapshotId is content-derived: `mintModelSnapshot` projects the
 *   table to a versioned canonical encoding of its stored shape and
 *   hashes it (`snap-v1:<sha256hex>`). Install and upgrade mint
 *   identically, so predecessor matching detects schema drift — a
 *   tampered store cannot match a plan compiled against different
 *   definitions — and no id registry exists.
 * - digest is the installing artifact's digest (caller-supplied code
 *   binding), preserving the serve gate's pinned `artifactDigest`
 *   comparison: joint predecessor matching then verifies exact schema
 *   AND exact code together, and code-only releases flow as
 *   digest-pointer moves with empty directives.
 * - The projection binds the stored row shape plus storage-level
 *   constraints (field essence, refs, unique keys/groups, delete mode).
 *   Pipeline behavior (hooks, invariants, locks, server inits,
 *   containment, computed validations) rides with code identity via the
 *   plan's artifact identity, not the snapshot. DESIGN §11.1 additionally
 *   names locks/lifetimes, effective language version, resolved physical
 *   bindings/routing and persisted declaration contracts in the snapshot;
 *   the interim projection covers the stored-shape subset (locks also
 *   arrive as a separate validated engine input), versioned so the
 *   canonical L1 format can extend it. Non-serializable members fail
 *   minting loud through `stableStringify` instead of hashing
 *   silently-dropped content.
 * - The diff refuses ambiguity (JEV 3/3): only provable dispositions
 *   compile (implicit retains, backfill for added stored fields);
 *   renames and drops are operator declarations, and anything unmatched
 *   fails compilation listing every entry. The compiler never invents
 *   destruction or identity. Mappers stay operator code: backfill values
 *   cannot be synthesized.
 * - Same name means same identity; desired-only models start empty (no
 *   directive); definition-only changes (no name movement) compile to an
 *   empty directive list that still moves the digest pointer.
 * - `bodyDigest` content-addresses the compiled body
 *   (`body-v1:<sha256hex>` over owner, endpoints and directives) for
 *   plan registries and activation gates; the engine carries it.
 */
import type {
  MigrationDirective,
  MigrationTransition,
  ModelName,
} from '@canlang/contracts';
import type { ModelTable as StateModelTable } from '../mutation/models.js';
import { StateError } from '../errors.js';
import { stableStringify } from '../invocation/replay.js';

/** Interim snapshot encoding version; bump when the projection changes. */
export const COMPILED_SNAPSHOT_VERSION = 'snap-v1';

/** Interim transition-body encoding version. */
const COMPILED_BODY_VERSION = 'body-v1';

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

interface ProjectedField {
  readonly name: string;
  readonly valueType?: unknown;
  readonly trim?: unknown;
  readonly min?: unknown;
  readonly max?: unknown;
  readonly machine?: unknown;
  readonly required: boolean;
  readonly serverOnly: boolean;
  readonly default?: unknown;
  readonly array?: unknown;
  readonly nullable?: unknown;
}

interface ProjectedModel {
  readonly model: string;
  readonly fields: ReadonlyArray<ProjectedField>;
  readonly refs: ReadonlyArray<{ readonly field: string; readonly model: string }>;
  readonly uniqueKeys: ReadonlyArray<string>;
  readonly uniqueGroups?: ReadonlyArray<ReadonlyArray<string>>;
  readonly deleteMode: string;
}

function projectTable(models: StateModelTable): ReadonlyArray<ProjectedModel> {
  const names = [...models.keys()].map(String).sort();
  return names.map(name => {
    const def = models.get(name as ModelName);
    if (def === undefined) throw new StateError('validation', `Migration snapshot names unknown model ${JSON.stringify(name)}.`);
    const fields = Object.keys(def.fields).sort().map(fieldName => {
      const field = def.fields[fieldName]!;
      return {
        name: fieldName,
        ...(field.valueType === undefined ? {} : { valueType: field.valueType }),
        ...(field.trim === undefined ? {} : { trim: field.trim }),
        ...(field.min === undefined ? {} : { min: field.min }),
        ...(field.max === undefined ? {} : { max: field.max }),
        ...(field.machine === undefined ? {} : { machine: field.machine }),
        required: field.required,
        serverOnly: field.serverOnly,
        ...(field.default === undefined ? {} : { default: field.default }),
        ...(field.array === undefined ? {} : { array: field.array }),
        ...(field.nullable === undefined ? {} : { nullable: field.nullable }),
      };
    });
    const refs = [...def.refs]
      .map(ref => ({ field: String(ref.field), model: String(ref.model) }))
      .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
    const uniqueKeys = [...def.uniqueKeys].map(String).sort();
    const uniqueGroups = def.uniqueGroups?.map(group => [...group].map(String).sort());
    return {
      model: name,
      fields,
      refs,
      uniqueKeys,
      ...(uniqueGroups === undefined ? {} : { uniqueGroups }),
      deleteMode: def.deleteMode,
    };
  });
}

/**
 * Mint the interim content-derived snapshot id for one owner's model
 * table. Same table always mints the same id; any stored-shape
 * difference mints a different id. The digest half of the binding is the
 * installing artifact's digest (caller-supplied, never minted here).
 */
export async function mintModelSnapshot(models: StateModelTable): Promise<{ readonly snapshotId: string }> {
  if (!(models instanceof Map)) throw new StateError('validation', 'Migration snapshot mints from a model table.');
  let encoded: string;
  try {
    encoded = stableStringify({ version: COMPILED_SNAPSHOT_VERSION, models: projectTable(models) });
  } catch {
    throw new StateError('validation', 'Migration snapshot projection holds non-serializable schema content.');
  }
  const hex = await sha256Hex(encoded);
  return { snapshotId: `${COMPILED_SNAPSHOT_VERSION}:${hex}` };
}

export interface CompiledRename {
  readonly from: string;
  readonly to: string;
}

export interface CompiledFieldRef {
  readonly model: string;
  readonly field: string;
}

export interface CompiledFieldRename extends CompiledFieldRef {
  readonly to: string;
}

export interface CompileMigrationTransitionInput {
  readonly owner: string;
  readonly oldModels: StateModelTable;
  readonly desiredModels: StateModelTable;
  /** Installing artifact digest of the old release (code half of `from`). */
  readonly fromArtifactDigest: string;
  /** Installing artifact digest of the desired release (code half of `to`). */
  readonly toArtifactDigest: string;
  /** Old model name -> desired model name (no chains: `to` must not be an old name). */
  readonly modelRenames?: ReadonlyArray<CompiledRename>;
  /** Field renames; `model` names the OLD model (pre-model-rename, per the engine). */
  readonly fieldRenames?: ReadonlyArray<CompiledFieldRename>;
  readonly modelDrops?: ReadonlyArray<string>;
  /** Field drops; `model` names the OLD model. */
  readonly fieldDrops?: ReadonlyArray<CompiledFieldRef>;
  /** Handler contracts to invalidate (caller-stated, passed through sorted). */
  readonly invalidates?: ReadonlyArray<string>;
  /** Rename this owner from another installed owner pointer. */
  readonly renameOwnerFrom?: string;
  /** Remove this owner; exclusive with every other declaration, desired must be empty. */
  readonly dropOwner?: boolean;
  readonly migrationId?: string;
}

function nonemptyText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new StateError('validation', `Migration compilation requires ${what}.`);
  return value;
}

function fieldNames(def: { readonly fields: Record<string, unknown> }): ReadonlySet<string> {
  return new Set(Object.keys(def.fields));
}

/**
 * Compile one owner's transition. Refuses ambiguous diffs (listing every
 * unmatched model/field), no-change compilations, and conflicting or
 * dangling declarations. Deterministic: same inputs compile to identical
 * transition bytes, including the default migration id.
 */
export async function compileMigrationTransition(input: CompileMigrationTransitionInput): Promise<MigrationTransition> {
  const owner = nonemptyText(input.owner, 'a nonempty owner.');
  const oldModels = input.oldModels;
  const desiredModels = input.desiredModels;
  if (!(oldModels instanceof Map) || !(desiredModels instanceof Map)) throw new StateError('validation', 'Migration compilation reads old and desired model tables.');
  const modelRenames = input.modelRenames ?? [];
  const fieldRenames = input.fieldRenames ?? [];
  const modelDrops = input.modelDrops ?? [];
  const fieldDrops = input.fieldDrops ?? [];
  const invalidates = input.invalidates ?? [];
  const dropOwner = input.dropOwner ?? false;

  if (dropOwner) {
    if (modelRenames.length > 0 || fieldRenames.length > 0 || modelDrops.length > 0 || fieldDrops.length > 0 ||
        invalidates.length > 0 || input.renameOwnerFrom !== undefined) {
      throw new StateError('validation', 'Migration compilation keeps owner removal exclusive: dropOwner carries no other declaration.');
    }
    if (desiredModels.size > 0) throw new StateError('validation', 'Migration compilation removes an owner only onto an empty desired table.');
  }
  if (input.renameOwnerFrom !== undefined && nonemptyText(input.renameOwnerFrom, 'a renameOwner source.') === owner) {
    throw new StateError('validation', 'Migration compilation renames an owner only from a different installed owner.');
  }

  const fromId = await mintModelSnapshot(oldModels);
  const toId = await mintModelSnapshot(desiredModels);
  const from = { snapshotId: fromId.snapshotId, digest: nonemptyText(input.fromArtifactDigest, 'a nonempty from artifact digest.') };
  const to = { snapshotId: toId.snapshotId, digest: nonemptyText(input.toArtifactDigest, 'a nonempty to artifact digest.') };
  if (from.snapshotId === to.snapshotId && from.digest === to.digest) {
    throw new StateError('validation', `Migration compilation from ${JSON.stringify(from.snapshotId)} to itself changes nothing.`);
  }

  const oldNames = new Set([...oldModels.keys()].map(String));
  const desiredNames = new Set([...desiredModels.keys()].map(String));
  const renameTargetBySource = new Map<string, string>();
  const renameSources = new Set<string>();
  for (const rename of modelRenames) {
    const source = nonemptyText(rename.from, 'a model rename source.');
    const target = nonemptyText(rename.to, 'a model rename target.');
    if (!oldNames.has(source)) throw new StateError('validation', `Migration compilation renames unknown old model ${JSON.stringify(source)}.`);
    if (!desiredNames.has(target)) throw new StateError('validation', `Migration compilation renames model ${JSON.stringify(source)} onto missing desired model ${JSON.stringify(target)}.`);
    if (oldNames.has(target)) throw new StateError('validation', `Migration compilation refuses chained model rename ${JSON.stringify(source)} -> ${JSON.stringify(target)}.`);
    if (renameSources.has(source)) throw new StateError('validation', `Migration compilation renames old model ${JSON.stringify(source)} twice.`);
    if ([...renameTargetBySource.values()].includes(target)) throw new StateError('validation', `Migration compilation aims two model renames at ${JSON.stringify(target)}.`);
    renameSources.add(source);
    renameTargetBySource.set(source, target);
  }
  const droppedModels = new Set<string>();
  for (const name of modelDrops) {
    const model = nonemptyText(name, 'a model drop name.');
    if (!oldNames.has(model)) throw new StateError('validation', `Migration compilation drops unknown old model ${JSON.stringify(model)}.`);
    if (renameSources.has(model)) throw new StateError('validation', `Migration compilation both renames and drops old model ${JSON.stringify(model)}.`);
    if (droppedModels.has(model)) throw new StateError('validation', `Migration compilation drops old model ${JSON.stringify(model)} twice.`);
    droppedModels.add(model);
  }

  // Old-namespace field declarations, resolved per old model.
  const fieldRenameByModel = new Map<string, Map<string, string>>();
  for (const rename of fieldRenames) {
    const model = nonemptyText(rename.model, 'a field rename model.');
    const source = nonemptyText(rename.field, 'a field rename source.');
    const target = nonemptyText(rename.to, 'a field rename target.');
    const oldDef = oldModels.get(model as ModelName);
    if (oldDef === undefined) throw new StateError('validation', `Migration compilation renames a field on unknown old model ${JSON.stringify(model)}.`);
    if (droppedModels.has(model)) throw new StateError('validation', `Migration compilation renames a field on dropped model ${JSON.stringify(model)}.`);
    const desiredModel = renameTargetBySource.get(model) ?? model;
    const desiredDef = desiredModels.get(desiredModel as ModelName);
    if (!fieldNames(oldDef).has(source)) throw new StateError('validation', `Migration compilation renames unknown old field ${JSON.stringify(model)}.${JSON.stringify(source)}.`);
    if (desiredDef === undefined || !fieldNames(desiredDef).has(target)) {
      throw new StateError('validation', `Migration compilation renames field ${JSON.stringify(model)}.${JSON.stringify(source)} onto missing desired field ${JSON.stringify(desiredModel)}.${JSON.stringify(target)}.`);
    }
    if (fieldNames(oldDef).has(target)) throw new StateError('validation', `Migration compilation refuses chained field rename ${JSON.stringify(model)}.${JSON.stringify(source)} -> ${JSON.stringify(target)}.`);
    const perModel = fieldRenameByModel.get(model) ?? new Map<string, string>();
    if (perModel.has(source)) throw new StateError('validation', `Migration compilation renames old field ${JSON.stringify(model)}.${JSON.stringify(source)} twice.`);
    if ([...perModel.values()].includes(target)) throw new StateError('validation', `Migration compilation aims two field renames at ${JSON.stringify(desiredModel)}.${JSON.stringify(target)}.`);
    perModel.set(source, target);
    fieldRenameByModel.set(model, perModel);
  }
  const fieldDropByModel = new Map<string, Set<string>>();
  for (const drop of fieldDrops) {
    const model = nonemptyText(drop.model, 'a field drop model.');
    const field = nonemptyText(drop.field, 'a field drop name.');
    const oldDef = oldModels.get(model as ModelName);
    if (oldDef === undefined) throw new StateError('validation', `Migration compilation drops a field on unknown old model ${JSON.stringify(model)}.`);
    if (droppedModels.has(model)) throw new StateError('validation', `Migration compilation drops a field on dropped model ${JSON.stringify(model)}.`);
    if (!fieldNames(oldDef).has(field)) throw new StateError('validation', `Migration compilation drops unknown old field ${JSON.stringify(model)}.${JSON.stringify(field)}.`);
    if (fieldRenameByModel.get(model)?.has(field) === true) throw new StateError('validation', `Migration compilation both renames and drops old field ${JSON.stringify(model)}.${JSON.stringify(field)}.`);
    const perModel = fieldDropByModel.get(model) ?? new Set<string>();
    if (perModel.has(field)) throw new StateError('validation', `Migration compilation drops old field ${JSON.stringify(model)}.${JSON.stringify(field)} twice.`);
    perModel.add(field);
    fieldDropByModel.set(model, perModel);
  }
  const invalidateSet = new Set<string>();
  for (const contract of invalidates) invalidateSet.add(nonemptyText(contract, 'a nonempty invalidate contract.'));

  if (dropOwner) {
    const directives: ReadonlyArray<MigrationDirective> = [{ kind: 'dropOwner' }];
    return finishTransition(owner, from, to, directives, input.migrationId);
  }

  // Refuse-ambiguous diff: every old model/field needs a disposition.
  const ambiguous: string[] = [];
  for (const model of [...oldNames].sort()) {
    if (renameSources.has(model) || droppedModels.has(model)) continue;
    if (!desiredNames.has(model)) ambiguous.push(`model ${JSON.stringify(model)}`);
  }
  for (const model of [...oldNames].sort()) {
    if (droppedModels.has(model)) continue;
    const desiredModel = renameTargetBySource.get(model) ?? model;
    const desiredDef = desiredNames.has(desiredModel) ? desiredModels.get(desiredModel as ModelName)! : undefined;
    const oldDef = oldModels.get(model as ModelName)!;
    const renames = fieldRenameByModel.get(model) ?? new Map<string, string>();
    const drops = fieldDropByModel.get(model) ?? new Set<string>();
    for (const field of [...fieldNames(oldDef)].sort()) {
      if (renames.has(field) || drops.has(field)) continue;
      if (desiredDef === undefined || !fieldNames(desiredDef).has(field)) ambiguous.push(`field ${JSON.stringify(model)}.${JSON.stringify(field)}`);
    }
  }
  if (ambiguous.length > 0) {
    throw new StateError('validation', `Migration compilation refuses ambiguous entries; declare each as a rename or a drop: ${ambiguous.join(', ')}.`);
  }

  const directives: MigrationDirective[] = [];
  if (input.renameOwnerFrom !== undefined) directives.push({ kind: 'renameOwner', from: input.renameOwnerFrom });
  for (const [source, target] of [...renameTargetBySource.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    directives.push({ kind: 'renameModel', from: source, to: target });
  }
  for (const model of [...droppedModels].sort()) directives.push({ kind: 'dropModel', model });
  for (const [model, renames] of [...fieldRenameByModel.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const [source, target] of [...renames.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      directives.push({ kind: 'renameField', model, from: source, to: target });
    }
  }
  for (const [model, drops] of [...fieldDropByModel.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const field of [...drops].sort()) directives.push({ kind: 'dropField', model, field });
  }
  // Added stored fields: backfill their (desired-namespace) model.
  const backfills = new Set<string>();
  for (const model of [...oldNames].sort()) {
    if (droppedModels.has(model)) continue;
    const desiredModel = renameTargetBySource.get(model) ?? model;
    const desiredDef = desiredModels.get(desiredModel as ModelName);
    if (desiredDef === undefined) continue;
    const oldDef = oldModels.get(model as ModelName)!;
    const claimed = new Set<string>([...fieldNames(oldDef)]
      .filter(field => !(fieldDropByModel.get(model)?.has(field) === true))
      .map(field => fieldRenameByModel.get(model)?.get(field) ?? field));
    for (const field of fieldNames(desiredDef)) {
      if (!claimed.has(field)) backfills.add(desiredModel);
    }
  }
  for (const model of [...backfills].sort()) directives.push({ kind: 'backfill', model });
  for (const contract of [...invalidateSet].sort()) directives.push({ kind: 'invalidate', handlerContract: contract });

  return finishTransition(owner, from, to, directives, input.migrationId);
}

async function finishTransition(owner: string, from: { readonly snapshotId: string; readonly digest: string },
  to: { readonly snapshotId: string; readonly digest: string }, directives: ReadonlyArray<MigrationDirective>,
  migrationId: string | undefined): Promise<MigrationTransition> {
  const bodyHex = await sha256Hex(stableStringify({ version: COMPILED_BODY_VERSION, owner,
    fromSnapshotId: from.snapshotId, fromDigest: from.digest, toSnapshotId: to.snapshotId, toDigest: to.digest, directives }));
  return {
    migrationId: migrationId === undefined ? `mig-${bodyHex.slice(0, 16)}` : nonemptyText(migrationId, 'a nonempty migration id.'),
    owner,
    fromSnapshotId: from.snapshotId,
    fromDigest: from.digest,
    toSnapshotId: to.snapshotId,
    toDigest: to.digest,
    bodyDigest: `${COMPILED_BODY_VERSION}:${bodyHex}`,
    directives: [...directives],
  };
}
