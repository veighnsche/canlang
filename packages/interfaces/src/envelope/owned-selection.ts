/**
 * Explicit owned-validation installation for artifact operations
 * (VALIDATION-012 A).
 *
 * Production selection for the HTTP/State/ordinary-MCP profiles works
 * in two steps. First, `deriveOwnedOperationSchema` maps one artifact
 * operation to a values owned schema when every duty maps exactly,
 * and selects the explicit TS-only path otherwise — carrier inputs
 * (`ref`/`user`/`file`/`nominal`/delivery), host defaults and
 * unmappable bounds stay on the host shells, never silently inside
 * native execution. Second, `installOwnedValidation` registers one
 * shared owner/plan pair and records the genuine `values.coverage`
 * selection per operation: `native` operations dispatch the owned
 * resolve join (genuine native execution with the installed
 * exact-codec capability); `ts-only` operations never enter the gate
 * and validate exactly as before. Handlers honor the recorded
 * selection and never re-decide coverage at runtime.
 */
import type { ArtifactOperation } from '@canlang/contracts';
import {
  classifyOwnedSelection,
  loadOwnerPlan,
  type OwnedSelection,
  type OwnedTarget,
  type ValidationBackend,
} from '@canlang/values/bindings/validation';
import type { OwnedOperationValidation } from '../ports.js';

export interface OwnedBudgets {
  readonly nodes: number;
  readonly depth: number;
  readonly text: number;
  readonly entries: number;
}

export interface OwnedInstallOptions {
  /** Owner revision the installation binds (a new artifact needs a fresh install). */
  readonly ownerRevision: string;
  /** Registry bound for the installing owner scope. */
  readonly bound: number;
  /** Traversal budgets every installed operation executes under. */
  readonly budgets: OwnedBudgets;
  /**
   * Whether the installed operation requires `operation_id` (the
   * values `mutation` flag): HTTP requires it on every operation;
   * MCP requires it only on mutation kinds. Reads without an id
   * would otherwise deny as unknown-argument.
   */
  readonly mutationFor: (operation: ArtifactOperation) => boolean;
}

/** One installed operation: the native handle plus its recorded selection. */
export interface InstalledOwnedOperation {
  readonly handle: OwnedOperationValidation | null;
  /** Recorded selection: `native` carries the serving handle,
   * `ts-only` carries the reason the operation stays on legacy. */
  readonly selection: OwnedSelection;
}

const SCALAR_KINDS: Readonly<Record<string, string>> = {
  integer: 'int',
  decimal: 'decimal',
  money: 'money',
  datetime: 'datetime',
  duration: 'duration',
  string: 'text',
  boolean: 'bool',
};

/**
 * Maps one artifact operation to a values owned schema. Returns the
 * schema when every input duty maps exactly onto the values core, or
 * the explicit TS-only reason otherwise. Legacy array `min`/`max`
 * are length bounds and ride only on array fields (scalar `min`/`max`
 * are legacy no-ops, so they are omitted rather than invented);
 * defaults stay with host evaluation, so defaulted inputs select
 * TS-only and keep their host identity.
 */
export function deriveOwnedOperationSchema(
  operation: ArtifactOperation,
): { readonly enums: Array<Record<string, unknown>>; readonly inputs: Array<Record<string, unknown>> } | { readonly tsOnly: string } {
  const enums: Array<Record<string, unknown>> = [];
  const inputs: Array<Record<string, unknown>> = [];
  const fields = operation.inputs.fields;
  for (const named of fields) {
    const tag = named.field;
    if (tag.kind === 'delivery') {
      continue;
    }
    if (named.default !== undefined || named.computedDefault === true) {
      return { tsOnly: `input '${named.name}' carries a host-evaluated default` };
    }
    const array = named.array !== undefined;
    let base: Record<string, unknown>;
    if (tag.kind === 'enum') {
      const enumName = `${operation.name}__${named.name}`;
      enums.push({ name: enumName, cases: [...tag.values] });
      base = { t: 'nominal', path: enumName };
    } else if (tag.kind === 'ref' || tag.kind === 'user' || tag.kind === 'file' || tag.kind === 'nominal') {
      return { tsOnly: `input '${named.name}' is a host-carried ${tag.kind}` };
    } else {
      const scalar = (SCALAR_KINDS as Record<string, string | undefined>)[tag.kind];
      if (scalar === undefined) {
        return { tsOnly: `input '${named.name}' has no values-core mapping` };
      }
      base = { t: 'scalar', name: scalar };
    }
    const leafName = tag.kind === 'enum' ? `${operation.name}__${named.name}` : (SCALAR_KINDS as Record<string, string>)[tag.kind]!;
    const typeId = `${leafName}${array ? '[]' : ''}${named.nullable === true ? '?' : ''}`;
    const input: Record<string, unknown> = {
      name: named.name,
      type_id: typeId,
      base,
      required: named.required,
    };
    if (array) {
      input['array'] = true;
      if (named.array?.required === true) input['required_array'] = true;
      if (named.min !== undefined) input['length_min'] = named.min;
      if (named.max !== undefined) input['length_max'] = named.max;
    }
    if (named.nullable === true) input['nullable'] = true;
    inputs.push(input);
  }
  return { enums, inputs };
}

/**
 * Installs owned validation for a slice of artifact operations: one
 * shared owner/plan registration over every derivable operation,
 * then the genuine `values.coverage` selection per operation target.
 * Operations the derivation declines are recorded as explicit
 * TS-only with their reason; installers serve handles only for
 * native-selected operations.
 */
export function installOwnedValidation(
  backend: ValidationBackend,
  exact: OwnedOperationValidation['exact'],
  operations: ReadonlyArray<ArtifactOperation>,
  options: OwnedInstallOptions,
): Map<string, InstalledOwnedOperation> {
  const derived = new Map<string, { readonly enums: Array<Record<string, unknown>>; readonly inputs: Array<Record<string, unknown>> }>();
  const tsOnly = new Map<string, string>();
  for (const operation of operations) {
    const mapped = deriveOwnedOperationSchema(operation);
    if ('tsOnly' in mapped) tsOnly.set(operation.name, mapped.tsOnly);
    else derived.set(operation.name, mapped);
  }
  const mergedEnums: Array<Record<string, unknown>> = [];
  const mergedOperations: Array<Record<string, unknown>> = [];
  const byName = new Map(operations.map((operation) => [operation.name, operation]));
  for (const [name, mapped] of derived) {
    mergedEnums.push(...mapped.enums);
    mergedOperations.push({
      name,
      mutation: options.mutationFor(byName.get(name)!),
      inputs: mapped.inputs,
    });
  }
  const out = new Map<string, InstalledOwnedOperation>();
  if (mergedOperations.length === 0) {
    for (const [name, reason] of tsOnly) {
      out.set(name, {
        handle: null,
        selection: { kind: 'ts-only', reason: 'host-carrier', detail: reason },
      });
    }
    return out;
  }
  const loaded = loadOwnerPlan(backend, {
    abi: 'v1',
    profile: 'values',
    planProfile: 'values/v1',
    backend: 'native',
    owner_rev: options.ownerRevision,
    bound: options.bound,
    schema: { t: 'normalized', contracts: [], enums: mergedEnums, operations: mergedOperations },
    provenance: { factory: 'normalizeSchema', owner_rev: options.ownerRevision },
  });
  for (const [name, reason] of tsOnly) {
    out.set(name, {
      handle: null,
      selection: { kind: 'ts-only', reason: 'host-carrier', detail: reason },
    });
  }
  for (const name of derived.keys()) {
    const target: OwnedTarget = { kind: 'operation', name };
    const selection = classifyOwnedSelection(backend, {
      owner: loaded.owner,
      plan: loaded.id,
      profile: 'values/v1',
      target,
    });
    if (selection.kind === 'native') {
      out.set(name, {
        selection,
        handle: {
          backend,
          exact,
          owner: loaded.owner,
          plan: loaded.id,
          budgets: options.budgets,
          selection,
        },
      });
    } else {
      out.set(name, { handle: null, selection });
    }
  }
  return out;
}

/**
 * Serves the catalog `ownedValidationFor` channel from an explicit
 * installation: native-selected operations return their handle,
 * every other operation returns null and validates exactly as
 * before. No coverage is (re-)decided here.
 */
export function ownedValidationForInstall(
  installs: ReadonlyMap<string, InstalledOwnedOperation>,
): (operation: string) => OwnedOperationValidation | null {
  return (operation: string): OwnedOperationValidation | null =>
    installs.get(operation)?.handle ?? null;
}
