/**
 * Lane 03 S7: structurally constrained migration mappers (pure, no I/O).
 *
 * A `MigrationMapper` transforms one frozen before-row into its desired
 * stored shape. The mapper is structural only: the before-row is
 * deep-frozen, the builder exposes ONLY `set`/`get`, and there is no
 * store/query/clock/actor access. Mapper bugs (non-`StateError` throws)
 * propagate untouched, never staged — the same contract as invoke
 * handlers. Builder misuse (uninitialized reads, unknown fields) throws
 * `StateError` validation, fail closed.
 *
 * INTERIM: mappers are engine callbacks until L1 compiles `backfill`
 * bodies; the `before`/`row` dataflow rules here mirror DESIGN §11.2
 * (frozen old row, initialized-before-read, every stored field assigned).
 */

import type { RecordParent, RecordVersion, StoredRow } from '../../../contracts/src/state.js';
import type { InterimModelDef } from '../mutation/models.js';
import { StateError } from '../errors.js';
import { checkJsonSafe, jsonClone } from '../internal/json.js';

/**
 * Deep-frozen before-row view: stored data, retained parent link, source
 * version, and archive state. Mappers observe; they never mutate.
 */
export interface FrozenBeforeRow {
  readonly data: Readonly<Record<string, unknown>>;
  readonly parent: RecordParent | null;
  readonly version: RecordVersion;
  readonly archived: boolean;
}

/**
 * Desired-row builder: `set` initializes a declared desired field,
 * `get` reads an initialized field. Reading an uninitialized field throws
 * `StateError` validation.
 */
export interface MigrationRowBuilder {
  set(field: string, value: unknown): void;
  get(field: string): unknown;
}

/** One structural row transformation: frozen before, partially built row. */
export type MigrationMapper = (before: FrozenBeforeRow, row: MigrationRowBuilder) => void;

/** Deep-freeze a cloned value so mapper/builder state cannot alias. */
function deepFreeze(value: unknown, seen: Set<unknown> = new Set()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return;
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
  Object.freeze(value);
}

/**
 * Freeze one live before-row into the mapper-visible view. The data and
 * parent are cloned first, so later store reads cannot alias mapper state.
 */
export function freezeBeforeRow(row: StoredRow): FrozenBeforeRow {
  const data = jsonClone(row.data as Record<string, unknown>, 'Migration before-row data');
  const parent =
    row.parent === undefined || row.parent === null
      ? null
      : jsonClone(row.parent, 'Migration before-row parent');
  deepFreeze(data);
  if (parent !== null) {
    deepFreeze(parent);
  }
  return Object.freeze({
    data,
    parent,
    version: row.version,
    archived: row.archivedAt !== null,
  });
}

/** Seeded builder plus its terminal `build` step (single-use). */
export interface SeededMigrationRowBuilder {
  readonly builder: MigrationRowBuilder;
  build(): Record<string, unknown>;
}

/**
 * Create a builder seeded with structurally-mapped values (seeds count as
 * initialized). Seed keys must be declared desired fields; values are
 * cloned and frozen, so mapper-held references cannot corrupt the build.
 */
export function createMigrationRowBuilder(
  seed: Readonly<Record<string, unknown>>,
  desiredDef: InterimModelDef,
): SeededMigrationRowBuilder {
  if (typeof seed !== 'object' || seed === null || Array.isArray(seed)) {
    throw new StateError('validation', 'Migration mapper seed must be an object.');
  }
  const initialized = new Map<string, unknown>();
  for (const [field, value] of Object.entries(seed)) {
    if (!Object.hasOwn(desiredDef.fields, field)) {
      throw new StateError(
        'validation',
        `Migration mapper seed sets undeclared field ${JSON.stringify(field)} on model ` +
          `${JSON.stringify(desiredDef.model as string)}.`,
      );
    }
    if (value === undefined) {
      throw new StateError(
        'validation',
        `Migration mapper seed for field ${JSON.stringify(field)} must be JSON data.`,
      );
    }
    const cloned = jsonClone(value, `Migration mapper value for field ${JSON.stringify(field)}`);
    deepFreeze(cloned);
    initialized.set(field, cloned);
  }
  let built = false;
  const builder: MigrationRowBuilder = {
    set(field: string, value: unknown): void {
      if (built) {
        throw new StateError('validation', 'Migration mapper wrote after the row was built.');
      }
      if (typeof field !== 'string' || !Object.hasOwn(desiredDef.fields, field)) {
        throw new StateError(
          'validation',
          `Migration mapper sets undeclared field ${JSON.stringify(field)} on model ` +
            `${JSON.stringify(desiredDef.model as string)}.`,
        );
      }
      if (value === undefined) {
        throw new StateError(
          'validation',
          `Migration mapper value for field ${JSON.stringify(field)} must be JSON data.`,
        );
      }
      const cloned = jsonClone(value, `Migration mapper value for field ${JSON.stringify(field)}`);
      deepFreeze(cloned);
      initialized.set(field, cloned);
    },
    get(field: string): unknown {
      if (typeof field !== 'string' || !Object.hasOwn(desiredDef.fields, field)) {
        throw new StateError(
          'validation',
          `Migration mapper reads undeclared field ${JSON.stringify(field)} on model ` +
            `${JSON.stringify(desiredDef.model as string)}.`,
        );
      }
      if (!initialized.has(field)) {
        throw new StateError(
          'validation',
          `Migration mapper reads uninitialized field ${JSON.stringify(field)} on model ` +
            `${JSON.stringify(desiredDef.model as string)}.`,
        );
      }
      return initialized.get(field);
    },
  };
  return {
    builder,
    build(): Record<string, unknown> {
      built = true;
      return Object.fromEntries(initialized);
    },
  };
}

/**
 * Reject `undefined` anywhere in a mapped row (top-level `undefined` is
 * already rejected at `set`; nested `undefined` would silently vanish in
 * the adapters' JSON round-trip). `NaN`/`Infinity` stay pipeline-lenient
 * (L2 codecs own numeric strictness).
 */
function checkNoUndefined(value: unknown, what: string): void {
  if (value === undefined) {
    throw new StateError('validation', `${what} must be JSON data.`);
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  const stack: unknown[] = [value];
  const seen = new Set<unknown>([value]);
  while (stack.length > 0) {
    const current = stack.pop();
    const entries =
      Array.isArray(current) === true
        ? (current as ReadonlyArray<unknown>).entries()
        : Object.entries(current as Readonly<Record<string, unknown>>);
    for (const [, entry] of entries) {
      if (entry === undefined) {
        throw new StateError('validation', `${what} must be JSON data.`);
      }
      if (typeof entry === 'object' && entry !== null && !seen.has(entry)) {
        seen.add(entry);
        stack.push(entry);
      }
    }
  }
}

/**
 * Validate one mapped row against its desired def: every stored field
 * initialized, no undeclared fields, required fields non-null (mirroring
 * the mutation pipeline, where `null` fails `required`), and JSON-safe
 * values (unknown rich types fail closed with validation, never crash).
 */
export function validateMappedRow(
  mapped: Readonly<Record<string, unknown>>,
  desiredDef: InterimModelDef,
): void {
  if (typeof mapped !== 'object' || mapped === null || Array.isArray(mapped)) {
    throw new StateError('validation', 'Migration mapped rows must be objects.');
  }
  for (const [field, fieldDef] of Object.entries(desiredDef.fields)) {
    if (!Object.hasOwn(mapped, field)) {
      throw new StateError(
        'validation',
        `Migration row for model ${JSON.stringify(desiredDef.model as string)} leaves stored ` +
          `field ${JSON.stringify(field)} uninitialized.`,
      );
    }
    const value = (mapped as Readonly<Record<string, unknown>>)[field];
    if (value === undefined) {
      throw new StateError(
        'validation',
        `Migration row for model ${JSON.stringify(desiredDef.model as string)} leaves stored ` +
          `field ${JSON.stringify(field)} uninitialized.`,
      );
    }
    if (fieldDef.required && value === null) {
      throw new StateError(
        'validation',
        `Migration row for model ${JSON.stringify(desiredDef.model as string)} leaves required ` +
          `field ${JSON.stringify(field)} null.`,
      );
    }
  }
  for (const field of Object.keys(mapped)) {
    if (!Object.hasOwn(desiredDef.fields, field)) {
      throw new StateError(
        'validation',
        `Migration row for model ${JSON.stringify(desiredDef.model as string)} sets undeclared ` +
          `field ${JSON.stringify(field)}.`,
      );
    }
  }
  const what = `Migration row for model ${JSON.stringify(desiredDef.model as string)}`;
  checkNoUndefined(mapped, what);
  checkJsonSafe(mapped, what);
}
