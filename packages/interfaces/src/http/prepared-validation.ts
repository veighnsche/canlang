/** Request-lifetime ordinary TS plans. Only a trusted loader supplies prepare:
 * it proves the actual descriptor/source association and current revision.
 * Neither a frozen catalog nor a request's revision string issues a plan.
 * HTTP still uses its canonical framing/binding evaluator, never native
 * adoption or transport defaults. */
import type { ClosedInputs } from '@canlang/contracts';
import { createServingValidation, type ServingValidation } from '@canlang/values/bindings/serving-validation';
import type { SchemaDescriptor } from '@canlang/values';
import type { SchemaCatalog } from '../ports.js';
import { prepareHttpPlan, runPreparedHttpPlan, type PreparedHttpOutcome, type PreparedHttpPlan } from '../envelope/prepared.js';

export interface SourceValidationRegistration {
  readonly ownerRevision: string;
  /** Null only for the existing explicitly unsupported Values plan profile.
   * The checked HTTP evaluator and current source still serve canonically;
   * no Values plan is claimed or retried under another backend. */
  readonly descriptor: SchemaDescriptor | null;
  readonly assertCurrent: () => Promise<void>;
  readonly assertStable: () => void;
}
interface Registration {
  readonly values: ServingValidation | null;
  readonly http: PreparedHttpPlan;
  readonly assertCurrent: () => Promise<void>;
  readonly assertStable: () => void;
}
interface CatalogState {
  active: boolean;
  readonly base: SchemaCatalog;
  readonly prepare: (operation: string) => Promise<SourceValidationRegistration>;
  readonly registered: Map<string, Registration>;
}
const issued = new WeakMap<SchemaCatalog, CatalogState>();
const issuedReaders = new WeakMap<object, SchemaCatalog>();

/** Host construction only: prepare must come from the verified source loader,
 * not wire data or a shape-derived artifact label. Each catalog serves one
 * HTTP request and closes even on body/admission failure. */
export function createSourceValidationCatalog(base: SchemaCatalog,
  prepare: (operation: string) => Promise<SourceValidationRegistration>): SchemaCatalog {
  if (typeof prepare !== 'function') throw new TypeError('Source validation requires its trusted loader.');
  const catalog: SchemaCatalog = Object.freeze({
    shapeFor: (operation: string) => base.shapeFor(operation),
    ...(base.derivedFor === undefined ? {} : { derivedFor: (operation: string) => base.derivedFor!(operation) }),
  });
  issued.set(catalog, { active: true, base, prepare, registered: new Map() });
  issuedReaders.set(catalog.shapeFor, catalog);
  if (catalog.derivedFor !== undefined) issuedReaders.set(catalog.derivedFor, catalog);
  return catalog;
}

function active(state: CatalogState): void {
  if (!state.active) throw new Error('Source validation catalog is closed.');
}

function refuseCopiedReaders(catalog: SchemaCatalog): void {
  for (const key of ['shapeFor', 'derivedFor']) {
    const descriptor = Object.getOwnPropertyDescriptor(catalog, key);
    if (descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'function' && issuedReaders.has(descriptor.value)) {
      throw new Error('Source validation requires its original catalog, not copied readers.');
    }
  }
}

/** Undefined means the pre-existing framing-only catalog, not fallback after
 * a registration failure. Issued catalog failures always propagate. */
export async function runSourceHttpPlan(catalog: SchemaCatalog, operation: string,
  inputs: ClosedInputs): Promise<PreparedHttpOutcome | undefined> {
  const state = issued.get(catalog);
  if (state === undefined) { refuseCopiedReaders(catalog); return undefined; }
  active(state);
  let registration = state.registered.get(operation);
  if (registration === undefined) {
    const source = await state.prepare(operation);
    active(state);
    const shape = state.base.shapeFor(operation), derived = state.base.derivedFor?.(operation);
    if (shape == null || derived == null) throw new Error('Source validation lacks its checked operation.');
    const http = prepareHttpPlan(operation, shape, derived);
    const values = source.descriptor === null ? null : createServingValidation({ abiVersion: 'values/v1', profileVersion: 'validation/v1',
      backendId: 'ordinary-ts-serving', ownerRevision: source.ownerRevision }, source.descriptor);
    try {
      await source.assertCurrent();
      active(state);
      source.assertStable();
      registration = { values, http, assertCurrent: source.assertCurrent, assertStable: source.assertStable };
      state.registered.set(operation, registration);
    } catch (error) { values?.close(); throw error; }
  }
  await registration.assertCurrent();
  active(state);
  registration.assertStable();
  registration.values?.plan();
  return runPreparedHttpPlan(registration.http, inputs);
}

/** After the existing last current-credential await, recheck this same source
 * lifetime immediately before canonical invocation. */
export async function assertSourceValidationCurrent(catalog: SchemaCatalog, operation: string): Promise<void> {
  const state = issued.get(catalog);
  if (state === undefined) { refuseCopiedReaders(catalog); return; }
  active(state);
  const registration = state.registered.get(operation);
  if (registration === undefined) throw new Error('Source validation was not registered for this operation.');
  await registration.assertCurrent();
  active(state);
  registration.values?.plan();
}

/** Synchronous final source comparison in the caller's own continuation,
 * with no await left between this check and canonical invocation. */
export function assertSourceValidationStable(catalog: SchemaCatalog, operation: string): void {
  const state = issued.get(catalog);
  if (state === undefined) { refuseCopiedReaders(catalog); return; }
  active(state);
  const registration = state.registered.get(operation);
  if (registration === undefined) throw new Error('Source validation was not registered for this operation.');
  registration.assertStable();
  registration.values?.plan();
}

export function closeSourceValidationCatalog(catalog: SchemaCatalog): void {
  const state = issued.get(catalog);
  if (state === undefined || !state.active) return;
  state.active = false;
  for (const registration of state.registered.values()) registration.values?.close();
  state.registered.clear();
}

/**
 * Explicit installed owned-validation selection for the HTTP profile
 * (`values/v1`).
 *
 * Production catalog factories never hand-inject `ownedValidationFor`
 * per request: they wrap the dispatch catalog ONCE with
 * `wrapCatalogWithOwnedValidation`, supplying `resolve` from the installed
 * native glue (the shipped `validationBackend` over the installed
 * `values_semantics` artifact) plus the released owner/plan pair,
 * the admitted budgets, and the fixed exact-codec capability bound
 * from the installed exact backend. Each operation resolves to its
 * handle or null (legacy path); operations without a handle validate
 * exactly as before. The wrapper delegates `shapeFor`/`derivedFor`
 * untouched, so framing, binding and source validation keep their
 * contracts — only the owned channel is added.
 */
export function wrapCatalogWithOwnedValidation(
  base: SchemaCatalog,
  resolve: (operation: string) => import('../ports.js').OwnedOperationValidation | null,
): SchemaCatalog {
  if (typeof resolve !== 'function') throw new TypeError('Installed owned validation requires its selection.');
  const catalog: SchemaCatalog = Object.freeze({
    shapeFor: (operation: string) => base.shapeFor(operation),
    ...(base.derivedFor === undefined ? {} : { derivedFor: (operation: string) => base.derivedFor!(operation) }),
    ownedValidationFor: (operation: string) => resolve(operation),
  });
  return catalog;
}
