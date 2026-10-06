// Native plan handle projection (V03.4 host half).
//
// Adopts live `prepared/plan.ts` plans into generation-scoped,
// native-tracked handles for A07.3 assembly. plan.ts owns plan DATA;
// this registry owns native HANDLE lifecycle only: adoption,
// generation retirement (retired plans are never evicted here or in
// plan.ts), disposal, and bounds. plan.ts is consumed read-only:
// `getValidationPlan` proves liveness in the owner scope before any
// handle exists, and foreign/stale/disposed handles fail before use.
//
// Handles are branded by issuance (module WeakSet), never by shape:
// forged objects and proxies around genuine handles are rejected.
import {
  getValidationPlan,
  type PlanId,
  type PreparedValidationPlan,
} from "../src/prepared/plan.js";

export type NativeHandleCode =
  | "foreign-handle"
  | "stale-generation"
  | "disposed-handle"
  | "registry-full";

export class NativePlanError extends Error {
  readonly code: NativeHandleCode;

  constructor(code: NativeHandleCode, message: string) {
    super(`native plan: ${message}`);
    this.name = "NativePlanError";
    this.code = code;
  }
}

/** Opaque adopted handle: issuer id plus adopting generation. */
export interface NativePlanHandle {
  readonly id: PlanId;
  readonly generation: number;
}

interface HandleEntry {
  readonly handle: NativePlanHandle;
  readonly plan: PreparedValidationPlan;
  readonly owner: object;
  readonly generation: number;
}

const ISSUED_HANDLES = new WeakSet<object>();

/**
 * One backend's native handle registry. The bound is a construction
 * input (no fixed number): non-positive bounds simply admit nothing.
 * Entries are scoped per owner (plan ids repeat across owners, so an
 * id alone never identifies a handle); the live set cannot outgrow
 * the bound, and superseded/disposed handles resolve through side
 * sets with precise codes.
 */
export class NativePlanRegistry {
  private readonly byHandle = new WeakMap<object, HandleEntry>();
  private scopes = new WeakMap<object, Map<string, HandleEntry>>();
  private readonly live = new Set<HandleEntry>();
  private readonly superseded = new WeakSet<object>();
  private readonly disposed = new WeakSet<object>();
  private generation = 0;

  constructor(private readonly bound: number) {}

  /** Currently adopting generation. */
  get activeGeneration(): number {
    return this.generation;
  }

  /** Live (current-generation, undisposed) handle count. */
  get liveCount(): number {
    return this.live.size;
  }

  /**
   * Adopts a live plan into a native-tracked handle. Liveness is
   * proved through plan.ts, so foreign owners and unknown/released
   * ids fail with the original PlanError before any handle exists.
   * Re-adopting a live (owner, id) returns its handle (idempotent).
   */
  adopt(owner: unknown, id: unknown): NativePlanHandle {
    const plan = getValidationPlan(owner, id);
    // getValidationPlan proved owner is a non-null object.
    const scopeOwner = owner as object;
    let scope = this.scopes.get(scopeOwner);
    const live = scope?.get(plan.id);
    if (live !== undefined) {
      return live.handle;
    }
    if (this.live.size >= this.bound) {
      throw new NativePlanError("registry-full", "native handle registry is at its bound");
    }
    const handle: NativePlanHandle = Object.freeze({
      id: plan.id,
      generation: this.generation,
    });
    ISSUED_HANDLES.add(handle);
    const entry: HandleEntry = { handle, plan, owner: scopeOwner, generation: this.generation };
    if (scope === undefined) {
      scope = new Map();
      this.scopes.set(scopeOwner, scope);
    }
    scope.set(plan.id, entry);
    this.byHandle.set(handle, entry);
    this.live.add(entry);
    return handle;
  }

  /**
   * Resolves a handle to its plan. Forged handles, retired
   * generations, and disposed handles fail closed with distinct codes.
   */
  get(handle: unknown): PreparedValidationPlan {
    if (typeof handle !== "object" || handle === null || !ISSUED_HANDLES.has(handle)) {
      throw new NativePlanError("foreign-handle", "handle was not issued by a native registry");
    }
    if (this.disposed.has(handle)) {
      throw new NativePlanError("disposed-handle", "handle was released");
    }
    if (this.superseded.has(handle)) {
      throw new NativePlanError("stale-generation", "handle is from a retired generation");
    }
    const entry = this.byHandle.get(handle);
    if (entry === undefined) {
      throw new NativePlanError("foreign-handle", "handle was not issued by this registry");
    }
    return entry.plan;
  }

  /**
   * Disposes one handle. Idempotent and total: unissued handles are
   * silent no-ops (teardown paths never fail); genuineness is
   * enforced at adopt/get.
   */
  release(handle: unknown): void {
    if (typeof handle !== "object" || handle === null || !ISSUED_HANDLES.has(handle)) {
      return;
    }
    this.disposed.add(handle);
    const entry = this.byHandle.get(handle);
    if (entry !== undefined) {
      this.live.delete(entry);
      this.scopes.get(entry.owner)?.delete(entry.plan.id);
    }
  }

  /**
   * Retires the current generation and starts the next. Older handles
   * go stale; plan.ts plans are untouched (no eviction anywhere:
   * release stays the only removal of live entries).
   */
  retireGeneration(): number {
    for (const entry of this.live) {
      this.superseded.add(entry.handle);
    }
    this.live.clear();
    this.scopes = new WeakMap();
    this.generation += 1;
    return this.generation;
  }
}
