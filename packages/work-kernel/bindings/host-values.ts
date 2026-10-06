// W03.2 — Host-side value carrier: call-local opaque reference lifecycle.
// Implements the C03 lifetime rules over W03.1 facts: retain identity or
// structuredClone at the existing profile point; dispose on every exit
// path; reject stale/cross-call indices; bound allocation; preserve
// clone failures. Untouched payloads/metadata are never inspectable:
// this module exposes no payload enumeration — materialization happens
// only via resolve/materialize at the profile's declared point.

import {
  validatePayloadRef,
} from '../src/facts.js';
import type {
  PayloadRef,
  PresenceTag,
  Rejection,
} from '../src/facts.js';

/** Minimal global structuredClone shape (Node >= 22 runtime). */
declare const structuredClone: <T>(value: T) => T;

function defaultClone<T>(value: T): T {
  return structuredClone(value);
}

/** Clone function injected per scope (default: global structuredClone). */
export type CloneFn = <T>(value: T) => T;

/** Typed rejection: stale/cross-call/bound/disposed ref failures. */
export class RefRejectionError extends Error {
  readonly rejection: Rejection;
  constructor(rejection: Rejection) {
    super(`wt.ref-rejected: ${rejection.code}: ${rejection.reasons.join('; ')}`);
    this.name = 'RefRejectionError';
    this.rejection = rejection;
  }
}

/** Deterministic cancellation failure at the current stage. */
export class CallCancelledError extends Error {
  constructor(stage: string) {
    super(`wt.call-cancelled at stage '${stage}'`);
    this.name = 'CallCancelledError';
  }
}

interface Slot {
  readonly payload: unknown;
  readonly presence: PresenceTag;
}

export interface CallScopeOptions {
  /** Explicit bound on live slots; exceeding rejects. */
  readonly maxLive: number;
  /** Clone used at the profile point; injectable for failure probing. */
  readonly clone?: CloneFn;
}

/**
 * One call's opaque handle table. Indices are valid only within this
 * scope; dispose/release is idempotent; clone failures preserve the
 * original failure (never substituted).
 */
export class CallScope {
  readonly token: string;
  private readonly maxLive: number;
  private readonly clone: CloneFn;
  private slots = new Map<number, Slot>();
  private nextIndex = 0;
  private disposed = false;
  /** Original clone failures, preserved in order. Never substituted. */
  readonly cloneFailures: unknown[] = [];

  constructor(token: string, options: CallScopeOptions) {
    this.token = token;
    this.maxLive = options.maxLive;
    this.clone = options.clone ?? defaultClone;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get liveCount(): number {
    return this.slots.size;
  }

  private liveIndices(): ReadonlySet<number> {
    return new Set(this.slots.keys());
  }

  /**
   * Retain a payload in this call's table. Rejects when disposed
   * (rejected load) or when the allocation bound is reached.
   */
  retain(payload: unknown, presence: PresenceTag): PayloadRef {
    if (this.disposed) {
      throw new RefRejectionError({
        code: 'stale-ref',
        reasons: ['call scope disposed: load rejected'],
      });
    }
    if (this.slots.size >= this.maxLive) {
      throw new RefRejectionError({
        code: 'oversized-frame',
        reasons: [`call allocation bound exceeded (maxLive ${this.maxLive})`],
      });
    }
    const index = this.nextIndex;
    this.nextIndex += 1;
    this.slots.set(index, { payload, presence });
    return { callToken: this.token, index };
  }

  /**
   * Resolve a ref to its slot. Rejects stale, foreign, and cross-call
   * indices. Resolution is the only path to a payload: there is no
   * enumeration API, so untouched payloads stay uninspectable.
   */
  resolve(ref: PayloadRef): Slot {
    const rejection = validatePayloadRef(ref, this.token, this.liveIndices());
    if (rejection !== null) {
      throw new RefRejectionError(rejection);
    }
    const slot = this.slots.get(ref.index);
    if (slot === undefined) {
      throw new RefRejectionError({
        code: 'stale-ref',
        reasons: [`payload index ${ref.index} is not live in this call`],
      });
    }
    return slot;
  }

  /**
   * Materialize at the profile point: 'retain' keeps result identity,
   * 'clone' applies structuredClone. Clone failures preserve and
   * rethrow the original failure.
   */
  materialize<T>(ref: PayloadRef, mode: 'retain' | 'clone'): T {
    const slot = this.resolve(ref);
    if (mode === 'retain') {
      return slot.payload as T;
    }
    try {
      return this.clone<T>(slot.payload as T);
    } catch (failure) {
      this.cloneFailures.push(failure);
      throw failure;
    }
  }

  /** Release one index. Idempotent: unknown indices are a no-op. */
  release(index: number): void {
    this.slots.delete(index);
  }

  /** Dispose the whole call allocation. Idempotent. */
  dispose(): void {
    this.slots.clear();
    this.disposed = true;
  }
}

/** Minimal cancellation-signal shape (real AbortSignal is assignable). */
export interface CancelSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface RunScopeOptions extends CallScopeOptions {
  /** Optional cancellation signal; abort disposes + fails deterministically. */
  readonly signal?: CancelSignal;
}

/**
 * Run `fn` inside a fresh call scope, disposing on success, exception,
 * cancellation, and rejected load. Cancellation fails deterministically
 * at the current stage.
 */
export async function runInScope<T>(
  token: string,
  options: RunScopeOptions,
  fn: (scope: CallScope) => T | Promise<T>,
): Promise<T> {
  const scope = new CallScope(token, options);
  const signal = options.signal;
  const aborted = (): boolean => signal?.aborted === true;
  const onAbort = (): void => {
    scope.dispose();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (aborted()) {
      throw new CallCancelledError('enter');
    }
    const result = await fn(scope);
    if (aborted()) {
      throw new CallCancelledError('exit');
    }
    return result;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    scope.dispose();
  }
}
