import type { DispatchClaim, OutboxItem, RetryPolicy } from '@canlang/contracts';
import { planRecoveryScan } from '../src/recovery.js';
import type { RecoverableRow, RecoveryPlan, RecoveryScanInput } from '../src/recovery.js';
import { DEFAULT_RETRY_POLICY } from '../src/retry.js';

/** Startup selection is explicit. The caller compiles the producer-owned asset. */
export type RecoveryPlannerOptions =
  | { readonly backend: 'ts' }
  // Runtime checks require a genuine compiled WebAssembly.Module. Using object
  // keeps Node consumers' declarations independent of DOM/Worker global libs.
  | { readonly backend: 'wasm'; readonly module: object };
export type RecoveryPlanner = (input: RecoveryScanInput) => RecoveryPlan;

type Unary = (handle: number) => number;
interface RecoveryAbi {
  memory: WebAssembly.Memory;
  can_recovery_abi_version: () => number;
  can_recovery_create: () => number;
  can_recovery_free: Unary;
  can_recovery_demand: Unary;
  can_recovery_claim_index: Unary;
  can_recovery_error_code: Unary;
  can_recovery_text_prepare: (handle: number, length: number) => number;
  can_recovery_text_ptr: Unary;
  can_recovery_text_len: Unary;
  can_recovery_text_reply: Unary;
  can_recovery_number_reply: (handle: number, value: number) => number;
  can_recovery_tag_reply: (handle: number, tag: number) => number;
  can_recovery_result_len: (handle: number, list: number) => number;
  can_recovery_result_select: (handle: number, list: number, index: number) => number;
}

const FUNCTIONS = [
  'abi_version', 'create', 'free', 'demand', 'claim_index', 'error_code',
  'text_prepare', 'text_ptr', 'text_len', 'text_reply', 'number_reply',
  'tag_reply', 'result_len', 'result_select',
] as const;
const ERRORS: Record<number, string> = {
  1: 'planRecoveryScan: nowMs must be finite and >= 0',
  2: 'planRecoveryScan: maxClaimAgeMs must be finite and >= 0',
  3: 'planRecoveryScan: policy.maxAttempts must be an integer >= 1',
  4: 'planRecoveryScan: policy.horizonMs must be finite and > 0',
  5: 'isClaimStale: nowMs must be finite and >= 0',
  6: 'isClaimStale: maxClaimAgeMs must be finite and >= 0',
};

function nativeFailure(message: string): Error {
  return new Error(`planRecoveryScan: native recovery ${message}`);
}

function word(value: number): number {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff) {
    throw nativeFailure('returned an invalid ABI word');
  }
  return value >>> 0;
}

// Validation predicates reject nonnumbers without coercion in the donor.
function validationNumber(value: unknown): number {
  return typeof value === 'number' ? value : NaN;
}

// Numeric source/storage facts are f64. Preserve absent numeric data as NaN
// and a null numeric read as zero; object/string/bigint coercion is outside
// this explicit native profile.
function arithmeticNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value === undefined) return NaN;
  if (value === null) return 0;
  throw new TypeError('planRecoveryScan: native profile requires number arithmetic facts');
}

interface Iteration<T> {
  iterator: Iterator<T>;
  next: Iterator<T>['next'];
  body: boolean;
}

function begin<T>(values: Iterable<T>): Iteration<T> {
  const iterator = values[Symbol.iterator]();
  if (iterator === null || (typeof iterator !== 'object' && typeof iterator !== 'function')) {
    throw new TypeError('Iterator result is not an object');
  }
  return { iterator, next: iterator.next, body: false };
}

function step<T>(iteration: Iteration<T>): IteratorResult<T> {
  iteration.body = false;
  const result = Reflect.apply(iteration.next, iteration.iterator, []) as IteratorResult<T>;
  if (result === null || (typeof result !== 'object' && typeof result !== 'function')) {
    throw new TypeError('Iterator result is not an object');
  }
  if (result.done) return { done: true, value: undefined };
  const value = result.value;
  iteration.body = true;
  return { done: false, value };
}

// For-of closes only an interrupted body. Its original thrown completion wins
// over a failing return getter/call. A failing next/done/value does not close.
function close(iteration: Iteration<unknown> | undefined): void {
  if (!iteration?.body) return;
  try {
    const finish = iteration.iterator.return;
    if (finish !== undefined && finish !== null) Reflect.apply(finish, iteration.iterator, []);
  } catch { /* Preserve the original body exception. */ }
}

/** One synchronous whole call; Rust never invokes host code or stages effects. */
export function createRecoveryPlanner(options: RecoveryPlannerOptions): RecoveryPlanner {
  if (options?.backend === 'ts') return planRecoveryScan;
  if (options?.backend !== 'wasm') {
    throw new TypeError('createRecoveryPlanner: explicit ts or wasm backend required');
  }
  if (WebAssembly.Module.imports(options.module).length !== 0) {
    throw nativeFailure('module must not import callbacks or host services');
  }
  const exports = new WebAssembly.Instance(options.module).exports;
  if (!(exports.memory instanceof WebAssembly.Memory)) throw nativeFailure('memory export is missing');
  for (const name of FUNCTIONS) {
    if (typeof exports[`can_recovery_${name}`] !== 'function') {
      throw nativeFailure(`export can_recovery_${name} is missing`);
    }
  }
  const abi = exports as unknown as RecoveryAbi;
  if (word(abi.can_recovery_abi_version()) !== 1) throw nativeFailure('ABI version is unsupported');

  return (input: RecoveryScanInput): RecoveryPlan => {
    const handle = word(abi.can_recovery_create());
    if (handle === 0) throw nativeFailure('call allocation failed');
    let claims: Iteration<DispatchClaim> | undefined;
    let rows: Iteration<RecoverableRow> | undefined;
    const claimRefs: DispatchClaim[] = [];
    let claim: DispatchClaim | undefined;
    let row: RecoverableRow | undefined;
    let item: OutboxItem | undefined;
    let policy: RetryPolicy | undefined;
    let failed = false;

    const check = (phase: number): number => {
      phase = word(phase);
      if (phase === 254) {
        const message = ERRORS[word(abi.can_recovery_error_code(handle))];
        if (message !== undefined) throw new RangeError(message);
        throw nativeFailure('protocol or allocation refused');
      }
      return phase;
    };
    const collectScanResult = (): RecoveryPlan => {
      const result: RecoveryPlan = { resume: [], retry: [], reconcile: [], awaiting: [], skipped: [], terminal: [], dead: [] };
      const lists = [result.resume, result.retry, result.reconcile, result.awaiting, result.skipped, result.terminal, result.dead];
      for (let list = 0; list < lists.length; list++) {
        const count = word(abi.can_recovery_result_len(handle, list));
        check(abi.can_recovery_demand(handle));
        for (let index = 0; index < count; index++) {
          if (word(abi.can_recovery_result_select(handle, list, index)) !== 1) throw nativeFailure('result selection refused');
          const units = frame();
          let value = '';
          for (let offset = 0; offset < units.length; offset += 8192) {
            value += String.fromCharCode(...units.subarray(offset, offset + 8192));
          }
          lists[list]!.push(value);
        }
      }
      return result;
    };
    const advanceClaims = (): void => {
      claims ??= begin(input.claims);
      const next = step(claims);
      if (next.done) tag(0);
      else { claim = next.value; claimRefs.push(claim); tag(1); }
    };
    const advanceRows = (): void => {
      rows ??= begin(input.rows);
      const next = step(rows);
      if (next.done) tag(0);
      else { row = next.value; item = row.item; tag(1); }
    };
    const tagItemState = (): void => {
      const state = item!.state;
      tag(state === 'pending' ? 0 : state === 'claimed' ? 1 : state === 'failed' ? 2 : state === 'uncertain' ? 3 : 4);
    };
    const replyClaimAt = (): void => {
      const index = word(abi.can_recovery_claim_index(handle));
      check(abi.can_recovery_demand(handle));
      if (index >= claimRefs.length) throw nativeFailure('claim reference is outside this call');
      number(claimRefs[index]!.claimedAt);
    };
    const tagEvidence = (): void => {
      const evidence = input.evidence(item!.id);
      tag(evidence === null ? 0 : evidence.kind === 'not-found' ? 1 : 2);
    };
    const frame = (): Uint16Array => {
      const pointer = word(abi.can_recovery_text_ptr(handle));
      const length = word(abi.can_recovery_text_len(handle));
      check(abi.can_recovery_demand(handle));
      // Refresh after every allocation/reentrant call; never retain a view.
      const buffer = abi.memory.buffer;
      if (pointer % 2 !== 0 || pointer > buffer.byteLength || length > (buffer.byteLength - pointer) / 2) {
        throw nativeFailure('text frame is outside memory');
      }
      return new Uint16Array(buffer, pointer, length);
    };
    const text = (value: unknown): void => {
      if (typeof value !== 'string') throw new TypeError('planRecoveryScan: native profile requires string IDs');
      if (value.length > 0xffffffff || word(abi.can_recovery_text_prepare(handle, value.length)) !== 1) {
        check(abi.can_recovery_demand(handle));
        throw nativeFailure('text allocation refused');
      }
      const units = frame();
      if (units.length !== value.length) throw nativeFailure('text length does not match');
      for (let i = 0; i < value.length; i++) units[i] = value.charCodeAt(i);
      check(abi.can_recovery_text_reply(handle));
    };
    const number = (value: unknown): void => { check(abi.can_recovery_number_reply(handle, arithmeticNumber(value))); };
    const validate = (value: unknown): void => { check(abi.can_recovery_number_reply(handle, validationNumber(value))); };
    const tag = (value: number): void => { check(abi.can_recovery_tag_reply(handle, value)); };

    const serveInputDemand = (demand: number): boolean => {
      switch (demand) {
        case 1: validate(input.nowMs); break;
        case 2: number(input.nowMs); break;
        case 3: validate(input.maxClaimAgeMs); break;
        case 4: number(input.maxClaimAgeMs); break;
        case 15: validate(input.nowMs); break;
        case 16: validate(input.maxClaimAgeMs); break;
        case 24: number(input.nowMs); break;
        default: return false;
      }
      return true;
    };
    const servePolicyDemand = (demand: number): boolean => {
      switch (demand) {
        case 5: policy = input.policy ?? DEFAULT_RETRY_POLICY; validate(policy.maxAttempts); break;
        case 6: number(policy!.maxAttempts); break;
        case 7: validate(policy!.horizonMs); break;
        case 8: number(policy!.horizonMs); break;
        case 22: number(policy!.maxAttempts); break;
        case 26: number(policy!.horizonMs); break;
        default: return false;
      }
      return true;
    };
    const serveRowDemand = (demand: number): boolean => {
      switch (demand) {
        case 10: text(claim!.outboxId); break;
        case 13: tag(row!.guardVerdict === false ? 0 : 1); break;
        case 14: text(item!.id); break;
        case 20: tag(row!.retryClass === 'transient' ? 1 : 0); break;
        case 21: number(item!.attempts); break;
        case 23: tag(row!.firstAttemptAtMs === null ? 0 : 1); break;
        case 25: number(row!.firstAttemptAtMs); break;
        case 30: text(item!.id); break;
        default: return false;
      }
      return true;
    };
    try {
      while (true) {
        const demand = check(abi.can_recovery_demand(handle));
        switch (demand) {
          case 0: return collectScanResult();
          case 9: advanceClaims(); break;
          case 11: advanceRows(); break;
          case 12: tagItemState(); break;
          case 17: replyClaimAt(); break;
          case 27: tagEvidence(); break;
          default:
            if (serveInputDemand(demand)) break;
            if (servePolicyDemand(demand)) break;
            if (serveRowDemand(demand)) break;
            throw nativeFailure('demand is unsupported');
        }
      }
    } catch (failure) {
      failed = true;
      throw failure;
    } finally {
      close(claims);
      close(rows);
      if (failed) {
        try { abi.can_recovery_free(handle); } catch { /* Preserve the original failure. */ }
      } else if (word(abi.can_recovery_free(handle)) !== 1) {
        throw nativeFailure('call cleanup refused');
      }
    }
  };
}
